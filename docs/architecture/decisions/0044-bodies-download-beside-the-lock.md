# ADR 0044: Bodies download beside the account lock and commit under it

Status: Accepted

## Problem

The account lock serializes every IMAP operation of a Mailbox Account (ADR 0003),
and message bodies download inside it:

- every full pass runs the live body lane on its one connection;
- a history batch fetches the bodies of the rows it just stored;
- the history lane ranks folders with missing archive bodies first.

A body download is the slowest IMAP work, and its speed belongs to the provider.
One hosted deployment saw a provider send single large downloads at 20-28 KB/s
while the same message arrived in 3 s on another mailbox. A 4-9 MB body then held
the lock for 200-300 s. Every new-mail wait over 10 s in 14 days (23 of 4,186)
sat behind same-account body work. Back-to-back history passes would delay new
mail the same way.

Two more defects share the cause. After the first 1 MiB chunk a streamed body
has no deadline, so one slow download can hold the lock until the lock budget
ends. `fetchBody` writes without the write fence, and `markMessageGone`
tombstones by id alone.

## Decision

- The rule becomes: one mirror-changing operation per Mailbox Account at a time.
  A body download changes no mirror row, so it runs beside the lock on its own
  connection and commits under the lock. Attachment downloads already run beside
  the lock (ADR 0042).
- `MirrorEngine.syncBodies(accountId, { client?, clientAccountId?, signal?, maxUnits? })`
  is the one body path. It reads at most `maxUnits` backlog batches and stops at
  `MAX_LOCK_HOLD_MS`; `remaining` says bodies may be left. A host-owned client
  must name its Mailbox Account. Shutdown closes the body connection. A unit is
  one bounded parsed-only UID-set fetch (up to 10 same-folder messages, 8 MiB) or
  one message. For each unit:
  1. **Read, no lock.** `getBodyBacklog` returns live-window rows first; in
     `metadata_and_bodies` mode and inside the backfill window it then returns
     archive rows, missing bodies before evidence upgrades. Both arms share the
     folder filters. An empty read opens no connection.
  2. **Download, no lock.** The client selects the folder again
     (`invalidateSelection`), so it sees every UID stored before the read. The
     unit has a deadline of 60 s plus 8 KiB/s of declared size, at most 30 min;
     on expiry the engine closes this connection and the run ends with
     `BodyDownloadTimeoutError`. A unit's result is all or nothing: a unit that
     fails, times out or is aborted stores no body and tombstones nothing. A
     command on a closed connection raises `ImapConnectionClosedError`, never
     an empty result that would read as a gone message.
  3. **Commit, under the lock, as soon as the unit arrives.**
     `withInteractiveAccountLock` with `fenceWrites` keeps the downloaded rows that still exist and are not provider-deleted,
     then writes, in the ADR 0028 order: evidence, `BodyStore.store`,
     `completeBodyStorage`. A message the provider reports gone is tombstoned
     only while its row still has the downloaded
     `(folder_path, uidvalidity, uid)`; a confirmed move keeps the row live.
- A row id is message identity and a confirmed move keeps it (ADR 0037), and
  every writer that deletes, resets or moves a row holds the lock (ADR 0042), so
  "exists and is not deleted" under the lock is the whole commit check.
- A unit that fails or times out is skipped by this engine with a doubling delay
  (1 min to 1 h), so one bad message cannot block the rest of the backlog. A
  restart retries it at once. A truncated body still never retries on its own.
- `syncBodies` writes no sync run and no account state. A body error never marks
  the account failed; the next run retries.
- `syncAccount` fetches no bodies. Removed: the in-lock body lane,
  `bodyBacklogOnly`, the history inline body fetch, the history reason `body`
  and its scan, `getHistoricalBodyBacklog`, `skipMailboxLock`,
  `SyncResult.bodiesFetched` and the id-only `markMessageGone`. A sync run no
  longer counts bodies, so new `imap_sync_runs.bodies_fetched` values stay 0;
  body progress is `imap_account_progress` and the folder body counters. The
  column is dropped in a later release, once hosts stop reading it.
- `fetchBody(id, force)` downloads beside the lock and commits through the same
  fenced commit.
- `syncAccountWithBodies` runs the pass, then `syncBodies`, and reports a failed
  body run beside the recorded pass. The worker, REST sync and CLI sync use it.
  A host that keeps a listener runs `syncBodies` on a second connection.

## Consequences

- New mail waits for no body download. A wake can meet only one short commit:
  database writes plus the body store write for at most one unit.
- History passes hold the lock for metadata only.
- A Mailbox Account uses one more provider connection while bodies download. A
  provider that refuses it leaves bodies in the backlog; metadata is unaffected.
- A new message's body can wait behind the same account's download in progress,
  up to its deadline. Its headers do not wait.
- A commit that waits 25 s for the lock ends the run and downloads the unit
  again next time.
- An object `BodyStore` uploads inside the commit hold, so a slow object store
  still lengthens the hold. Hosted parsed-only bodies are small objects; moving
  that upload out of the hold is a later choice.
- This amends ADR 0003 and the three-lanes record: the lock still serializes
  every mirror write and every mailbox-changing IMAP command; read-only body
  downloads are the exception.

## Verification

- Live DB: a body download held open does not block `syncAccount`; nothing is
  written before the commit lock.
- Live DB: a row deleted, reset or moved between download and commit is skipped
  or kept as the rules above say; a gone result after a move leaves the row live.
- A trickling server hits the deadline; only the body connection closes, and the
  next run skips that unit and fetches the rest.
- `syncAccount` and the history lane never fetch a body; `getHistoryBacklog` has
  no `body` reason; `getBodyBacklog` returns live rows before archive rows.
