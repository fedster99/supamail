# ADR 0045: Record and Skip Messages Whose Metadata Cannot Be Read

Status: Accepted

Date: 2026-10-13

## Context

A metadata FETCH batch fails as a whole when one message's response lacks a
required field, cannot be parsed, or exceeds a per-message limit. Partial
batches must not advance cursors, so that folder stops. When it is a priority
folder (Inbox, Sent), the account goes into backoff and then BROKEN. One
malformed message could therefore stop a mailbox until code changed or an
operator acted.

## Decision

- **Typed failures per message.** `fetchMessageMetadata` reads every message
  of a batch and raises `UnreadableMessagesError`, naming each message that
  could not be read with a fixed code:
  - `fetch_incomplete`: the response lacked it or a required field;
  - `structure_invalid`: its data cannot be parsed or stored;
  - `metadata_too_large`: it exceeds the 8 MiB write limit;
  - `too_many_attachments`: it exceeds the 5,000-attachment write limit.

  The aggregate batch budget stays a plain failure, because it names no single
  message.
- **A durable record, without content.** Each failure adds one attempt to
  `imap_folders.unreadable_messages`, a jsonb record for the folder generation.
  It is keyed by UID and holds the code, the attempt count, and the last failure
  time; the folder row supplies the Mailbox Account and folder. While a message
  has fewer than three attempts, its failure fails the batch as before. A brief
  provider glitch therefore never skips mail.
- **Skip on the third failure.** On a third failure the message is skipped and
  counted in `SyncResult.unreadableMessagesSkipped`, and the rest of the batch
  is fetched again. Cursors advance past it, and later passes no longer fetch
  it. This applies in incremental sync, first sync, history, and the audit's
  missing-in-DB repair. The repair neither refetches a skipped message nor
  counts it as drift.
- **Records that clean themselves up.** A message that reads fine after an
  earlier failure is forgotten. A complete audit forgets messages the provider
  no longer lists. A UIDVALIDITY reset clears the record with the folder's
  other cursors. At most 1,000 messages are recorded per folder; past that a
  new failure is not recorded, so the folder fails as before rather than grow
  the row without bound.
- **The count is exposed.** `get_sync_status` reports `unreadable_messages`
  per account, adds the `unreadable_messages` reason, and says how many
  messages could not be read. A mailbox with an unreadable message is not
  `fully_synced`.

The record is per-folder sync state, like the backfill watermarks. It lives on
the folder row rather than in a new table, so hosts that scope tables by tenant
need no new table, policy, or grant.

## Consequences

- One bad message delays its folder for two passes, then stops blocking it. The
  account no longer goes into backoff or BROKEN because of it.
- A skipped message is missing from the mirror until it is fixed at the
  provider. The count says so, so health does not lie.
- A server that cannot read many messages records at most 1,000 per folder;
  beyond that the folder fails visibly instead.
- Body fetch failures are unchanged. Body parsing is lenient, and no
  production evidence shows a message whose body blocks the body lane.

## Verification

- `poison-messages.integration.test.ts` proves:
  - an Inbox message is skipped on its third failure and Inbox keeps syncing;
  - later passes no longer fetch it, and `get_sync_status` counts it;
  - a recovered message is forgotten;
  - first sync and history skip and finish;
  - the audit neither counts nor repairs a skipped message, and forgets it once
    the provider deletes it;
  - UIDVALIDITY clears the record;
  - the cap fails closed.
- `imap-client.test.ts` proves each code is assigned while the readable
  messages are kept.

## References

- Sync engine scale spec §3.2, fact 13.
- ADR 0039: window from message date.
- ADR 0043, ADR 0044.
- `apps/api/src/imap-client.ts`, `apps/api/src/sync-engine.ts`,
  `apps/api/src/repository.ts`, `apps/api/src/search/sync-status.ts`
