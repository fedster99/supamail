# ADR 0047: A New Mailbox Is Read Text First

Status: Proposed

Date: 2026-10-27

## Context

An agent asks its first questions minutes after a mailbox connects. A hosted
deployment watched a new Mailbox Account with 8,970 messages inside the live
window on 2026-10-22:

- Initial sync mirrored 50 messages per folder per pass. Passes ran back to back
  (2–4 s apart) and took 30–85 s, because the body lane spent most of each pass
  downloading 40–70 bodies, about one a second at 0.2–0.9 MB/s.
- Eleven minutes after connecting the mirror held 1,759 message rows and about
  600 bodies; Inbox reached back one week. The agent's searches in that minute
  returned nothing 38 times out of 43.
- 90% of the live window's bodies were stored 4 h 42 min after connecting.

The body lane downloads the whole message to read its text. Attachments are not
kept (they are fetched from the server on demand), yet they are most of the
bytes: across the nine hosted mailboxes with more than 500 bodies, message
sizes were 8–40 times the decoded text in seven and under twice it in two.

The same deployment measured one Rackspace mailbox (22,679 Inbox messages,
read-only, one run each):

| Fetch, newest first | Messages | Time | Bytes |
| --- | ---: | ---: | ---: |
| Metadata (envelope, structure, flags, size), UID sets of 500 | 2,000 | 1.0 s | 3.4 MB |
| Header and text parts, one connection | 1,000 | 22.4 s | 61 MB |
| Header and text parts, one connection | 200 | 2.5 s | 10 MB |
| Full source of the same 200, UID sets of 25 | 200 | 20.2 s | 135 MB |
| Header and text parts, three connections | 3,000 | 25.2 s | 171 MB |
| Header and text parts, five connections | 5,000 | 39.3 s | 226 MB |

The server limits one mailbox to about 6–7 MB/s: more connections add little.
One connection can mirror the metadata in seconds and the text of thousands of
messages a minute. The mirror is slow because of the order and the size of what
it fetches, not because of the server.

## Decision

A new mailbox is mirrored in three steps, all inside the existing lanes, under
the existing account lock, on the one connection the account already uses:
metadata first, then text, then everything else.

- **Initial sync finishes its metadata in one pass.** `INITIAL_SYNC_BATCH_SIZE`
  defaults to 500 (`MAX_SYNC_BATCH_SIZE`). A folder whose initial sync is
  incomplete runs its batches back to back until it completes or the
  cooperative lock budget expires. The budget is checked between batches for
  priority folders too; the batch in flight still finishes. Each batch commits
  and advances the watermark as before, a failed batch advances nothing, and the
  live-head batch rule is unchanged.
- **A large backlog is read text first.** When more live-window messages have
  no stored body than one pass fetches in full (`MAX_BODY_BATCHES_PER_TICK` ×
  `BODY_BACKFILL_BATCH_SIZE`, 100 by default), the body lane fetches only their
  text. Otherwise it uses the full path, as today.
  - From the stored BODYSTRUCTURE it requests `BODY.PEEK[HEADER]` and, for
    every leaf that is `text/plain` or `text/html` and not an attachment, plus
    every `text/calendar`, `application/ics`, or `application/icalendar` leaf,
    the leaf's MIME header and content.
  - One UID-set FETCH covers same-folder messages that request the same part
    list, at most 250 messages and 8 MiB of part bytes by their BODYSTRUCTURE
    sizes. A message with a part over 4 MiB, without stored BODYSTRUCTURE, or
    whose answer lacks a requested part takes the full path.
  - The header and leaves are reassembled in the message's own multipart
    structure and parsed by the same MIME parser as a full body. Text, HTML,
    plain text, the selected part and format, the search extract,
    `threading_payload_sha256`, and the headers are the values a full parse
    gives.
  - The store keeps the body lane's order. First the evidence: search extract,
    threading evidence, provider-resource and calendar evidence, with
    `structured_evidence_complete = false` and no raw, parsed, or authored
    delivery digest, because the body is not complete. Then the host's
    `BodyStore`. Then completion, which sets `body_fetched_at` and the new
    `imap_message_bodies.text_only = true`.
  - Text batches continue until no message without a body remains or the lock
    budget expires. They are not counted against `MAX_BODY_BATCHES_PER_TICK`:
    the backlog they drain is finite, and the history lane still waits for
    them.
- **The full body follows.** The body backlog includes `text_only` rows after
  rows with no body. Below the threshold the lane fetches them through the
  existing full path, under the existing per-pass cap and lock budget. That
  path writes the complete evidence and delivery digests, stores the full
  payload through `BodyStore` for the same message, and clears `text_only`.
- **Coverage says what is stored.** A live or priority body counts as complete
  only when `text_only = false`, so progress stays below 100% until the full
  bodies arrive. Reads do not change: a `text_only` body has the full text and
  HTML, and attachments are listed from the message row as before.
- Public migration `0033_text_only_bodies` adds `text_only boolean NOT NULL
  DEFAULT false` to `imap_message_bodies` and adds `NOT body.text_only` to the
  complete-body predicate of `imap_account_progress`.

Unchanged: one IMAP operation per account at a time, the lane order, evidence
before store before completion, the live window, the history lane, and the
initial-sync snapshot and watermark rules.

Not chosen:

- **A separate importer that hands over to the engine.** It would need its own
  connection or the account lock, and it would have to leave exactly the
  watermarks, evidence, and projections sync expects. Two writers of one mirror
  would drift. The engine already has a first-import state and a handover:
  `initial_sync_complete` and the backlog.
- **Parallel connections per mailbox.** Three connections were 2.7 times one,
  five barely more than three, and they would break the one-operation rule.
- **Searching metadata before text.** With text in minutes, the agent rarely
  sees a mailbox without it. This ADR does not add metadata-only search
  documents.

## Consequences

- With the measured rates, a mailbox like the one above has its live-window
  metadata within about a minute and its text within minutes instead of hours.
  These are estimates until the verification below runs against a real server.
- During a first import a pass holds the account lock longer, up to the
  10-minute budget. A change in another folder waits for the next pass, as it
  already does behind a long pass.
- A message is fetched twice: text, then the full body. The text adds about a
  tenth of the full bytes once. The full fetch costs what it costs today, which
  matters for servers with daily download caps.
- Until its full body arrives, a copy filed in two folders can appear as two
  deliveries, because no delivery digest exists yet. Threading enqueues the new
  evidence when it arrives, as for any recovered body evidence.
- A host's `BodyStore` and search indexing now see text at the server's speed.
  A slow per-message store becomes the limit. The hosted deployment's search
  drain is that host's own work.
- `text_only` is a mirror column, so every host's coverage queries that copy
  the complete-body predicate must add it.

## Verification

- Unit: part selection from BODYSTRUCTURE (single part, alternative, related,
  mixed with attachments, calendar invitations, no text part, oversized part).
- Unit: for each MIME fixture, the reassembled text-only parse equals the full
  parse in text, HTML, plain text, selected part and format, search extract,
  threading digest, and headers.
- Live DB: one pass completes a folder's initial sync in batches of 500 inside
  the budget; an interrupted pass resumes from the watermark; a failed batch
  advances nothing.
- Live DB: above the threshold the lane stores `text_only` bodies with
  `structured_evidence_complete = false` and no delivery digest; below it,
  as today. Coverage excludes `text_only` rows, the full path clears the flag
  and writes the digests, and history waits until the text is done.
- Spec conformance: a new scenario mirrors a mailbox text first, then in full,
  with the same message ids, threads, and search results.
- Throughput: the lab mirrors a populated mailbox text first, and the hosted
  deployment repeats the Rackspace measurement through the engine before
  re-pinning.

## References

- `apps/api/src/sync-engine.ts` (`runInitialSyncBatch`, `fetchBodyBacklog`)
- `apps/api/src/imap-client.ts` (`fetchFullMessageBodyBatch`)
- `apps/api/src/repository.ts` (`getBodyBacklog`, `storeBodyEvidenceBatch`)
- `apps/api/src/mime.ts`
- ADR 0008, 0012, 0027, 0028
