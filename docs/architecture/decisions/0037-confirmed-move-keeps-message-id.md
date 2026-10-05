# ADR 0037: A Confirmed Move Keeps The Message Id; By-Id Reads Are Live Only

Status: Accepted

Date: 2026-10-05

## Context

ADR 0034 tombstones a moved message's source row as soon as the provider confirms
the `MOVE`, and leaves the destination row to the destination folder's next sync.
Production tests through the hosted REST API on 2026-10-05 showed two results:

- A moved message was absent from every read until the destination synced: 44 s
  on a healthy Rackspace mailbox, and 21 minutes during a sync outage. The move
  result gave the caller no id to use.
- The old id still read as a live message in its old folder. `read_message`, the
  attachment reads, `getRawMime`, and `getMessageHeaders` selected the row by id
  without checking `deleted_in_provider`, while search, threads, drafts, folder
  counts, and the mutations all treat a tombstoned row as gone. Liveness was an
  opt-in `requireLive` flag on the shared loader, so each new read had to remember
  it.

The provider does name the destination: UIDPLUS `COPYUID` reports the destination
UIDVALIDITY and the new UID. ADR 0033 already trusts the same kind of server
answer (`APPENDUID`) to write a saved draft's row. Using it for a move is not a
guess.

## Decision

**A move the server confirms with COPYUID moves the row with the message.**
`moveMessage` and each member of `moveThread` update the source row's
`folder_id`, `folder_path`, `uidvalidity`, and `uid` to the destination
(`MirrorRepository.relocateMovedMessage`). The row keeps its id, so everything
keyed by it stays attached: body, attachments, thread assignments, and host
state such as hosted Tags. The destination's next sync upserts the same
`(account_id, folder_path, uidvalidity, uid)` key and updates this row.

Relocation applies only when all of these hold; otherwise the source row is
tombstoned as in ADR 0034, and the next sync mirrors the copy under a new id:

- the server reported COPYUID for this UID;
- the destination folder is tracked, at the UIDVALIDITY that COPYUID reported;
- no row holds the destination key yet (a sync that already mirrored the copy
  wins; a unique violation in the same race is the same answer).

The move result says which happened: `MoveResult.idKept`, and
`ThreadMoveResult.idsNotKept`.

**A delete still ends the identity.** Hard delete and Trash delete keep ADR 0034:
the source row is tombstoned. A deleted message reappears in Trash only through
Trash's sync, under a new id.

**By-id reads are live only.** `loadMessageAndAccount` always refuses a
tombstoned row with `NotFoundError`, and the `requireLive` flag is gone.
`read_message`, `listAttachments`, `getAttachmentMetadata`, `getRawMime`, and
`getMessageHeaders` select only live rows. Search keeps its explicit
`includeDeleted` option for history.

A mirror write that fails after a confirmed move never fails the move; it logs
and leaves the folders due for reconcile, as ADR 0034 does for tombstones.

## Consequences

- After a confirmed move, the same id reads the message in its new folder at
  once. Hosts that key state by message id keep it across moves.
- The folder counts of ADR 0036 follow the row: the statement trigger subtracts
  it from the source folder and adds it to the destination.
- A hosted webhook that reports changed rows by `updated_at` sees a move as a
  change of that message, not as a newly received one.
- A server without UIDPLUS, or an untracked destination, keeps ADR 0034's
  behavior, and the caller learns it from `idKept: false`.
- A tombstoned row is never served by id, so a client can no longer read a
  message's stored body after the provider deleted it.

## Verification

- `mailbox-mutations.test.ts`: COPYUID relocates and keeps the id; no COPYUID, a
  missing UID in the map, or a destination that does not qualify tombstones;
  a failed mirror write still succeeds; `moveThread` reports `idsNotKept`.
- `move-relocation.live-db.test.ts` (real Postgres): relocation keeps the id,
  body, and attachment and moves the folder counts; the destination's later sync
  updates the same row; a taken key, an untracked folder, a UIDVALIDITY
  mismatch, or an unmirrored folder writes nothing; `moveMessage` end to end; and
  every by-id read refuses a tombstoned row.
