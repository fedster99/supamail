# ADR 0046: A Message An Action Files Is Mirrored At Once

Status: Accepted

Date: 2026-10-26

## Context

ADR 0033 had a saved draft write its row from APPENDUID and values the save
composed, and left the body to the body lane. A sent copy wrote no row at all.
A hosted deployment measured the gap over 14 days to 2026-10-26:

- A draft's body landed a median of 14 s after its row (slowest tenth 50 s).
  `read_message` right after `save_draft` came back partial, with no body, 14
  times across 4 tenants, a median of 4 s after the save; reads about 15 s later
  succeeded.
- The Sent copy of a send landed a median of 16.5 s after the send finished
  (slowest tenth 77 s, slowest 197 s), so a read in that window could not see it.
- The connected servers answer APPEND with APPENDUID, and their RFC822.SIZE
  equals the stored bytes on 2,685 of 2,687 Drafts and Sent rows (the other 2
  were truncated).

## Decision

After a provider-acknowledged APPEND returns APPENDUID, the action mirrors that
one message as sync would, on its own connection and under the account lock it
already holds with fenced writes. `mirrorFiledMessage` (`filed-message.ts`) does
this for draft create and update, and `fileSentCopy` for the Sent copy of a send
and a draft send.

- **The row is the server's.** The action selects the folder again (it may still
  be selected from before the APPEND), checks that its
  UIDVALIDITY is the APPENDUID's, fetches that UID's metadata with sync's
  `fetchMessageMetadata`, and writes it through sync's `upsertMessages`. The row
  has the server's flags, BODYSTRUCTURE, attachment rows and provider ids. The
  composed-metadata row of ADR 0033 is removed.
- **The body is the filed bytes.** The action already holds the exact bytes it
  filed. When the server reports exactly that many bytes, under
  `BODY_RAW_MAX_BYTES` and the body lane's 4 MiB batch bound, the action parses
  them and stores the body in the body lane's order: evidence, the host's
  `BodyStore`, then `completeBodyStorage`. A larger body, or another byte count,
  is left to the body lane, which streams it on a worker rather than in the
  request. No stored body is fetched again.
  `buildRawMime` writes every line break as CRLF (RFC 5322), as servers store
  a filed message; with bare LF breaks a multi-line body never matched the
  server's byte count (found in production on 2026-10-28: 4 of 5 drafts).
- **Keyed retries.** A keyed save that finds an earlier attempt's copy returns its
  live row id. When that copy has no row yet, the retry mirrors the row only: the
  earlier attempt's bytes may differ from this one's, so its body is left to the
  body lane.
- **The host's body store.** `MailboxActionOptions.bodyStore` takes the store the
  host gives sync; without one the action uses the OSS database store, as sync
  does. Sync hooks do not run; they belong to sync.
- **Narrow guard.** Only a folder that is tracked, not missing, and already read
  by sync at the APPENDUID's UIDVALIDITY qualifies. Without APPENDUID, or without
  such a folder, the next sync mirrors the message as before.
- **Failures never fail the action.** The provider already holds the message. A
  failed read or row write is a warning and leaves no id; a failed body store is
  a warning and keeps the id. Sync repairs both.
- **Sync stays authoritative.** The write leaves `last_uid` unchanged. Sync reads
  the UID again, keeps the row id, and does not fetch a stored body again.
- **Send results.** `SendResult.messageId` is the Sent copy's mirror id, or null.
  Both send paths now hold the account lock with fenced writes and use one
  `ActionConnection` for the Sent APPEND and its mirror.

This amends ADR 0017: the send path may read back the one UID the server just
named for it, and nothing else. The sync read adapter still gains no write verb.

## Consequences

- A sent copy and a saved draft are readable by their returned mirror id with
  their stored body and attachment metadata before the action returns, when the
  guards above pass. Search indexing and derived conversation assignment still
  follow their existing processing paths; this change does not wait for them.
- Each mirrored APPEND costs one SELECT and one FETCH of one UID's metadata on an
  open connection, and one body store write that sync would otherwise do later.
  A draft save reports it as the `mirror` step of `IMAP_STEPS`. An action that
  files a message holds the account lock for that extra time.
- A reply seeded from an assigned message joins its conversation in `read_thread`
  when the threading lane next assigns it, and hosted search sees it when its
  index next drains; neither waits on the action.

## Verification

- `filed-message.test.ts`: evidence, the host store and readability happen in the
  body lane's order; mismatched folder identity prevents writes; changed size,
  the byte cap, the 4 MiB bound, no filed bytes and existing bodies skip storage; storage failure keeps the row id;
  mirror failure preserves confirmed Sent filing. Real database and protocol
  tests below cover successful filing rather than repeating it in mocks.
- `drafts.test.ts`, `send.test.ts`: create and both sends hold fenced locks;
  create and update pass the APPENDUID, bytes, socket and host body store to the
  mirror and time it as `mirror`; a keyed retry mirrors only the earlier copy's
  row; both sends pass the delivered bytes and host body store to the Sent filing.
- `drafts.live-db.test.ts`: against real Postgres, a saved draft is readable at
  once with its body, and a later sync upsert keeps its id.
- Dovecot smoke: a draft saved with an idempotency key is readable at once with
  its body and BODYSTRUCTURE, and the next sync keeps its id and body.
- GreenMail smoke: a send returns the Sent copy's id, readable at once with its
  In-Reply-To header, and the next sync keeps it. GreenMail reports an RFC822.SIZE smaller
  than the stored bytes, so there the body is left to the body lane.

## References

- ADR 0017: the send primitive; amended here.
- ADR 0028: the body store seam and the body lane's storage order.
- ADR 0033: the saved draft row; its composed metadata is superseded here.
- ADR 0043: `ActionConnection`.
- RFC 4315 (UIDPLUS) §3: APPENDUID.
