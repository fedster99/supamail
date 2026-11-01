# ADR 0049: Bodies download beside the account lock and commit under it

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
the lock for 200-300 s. Over 30 days, passes that fetched bodies were 437 of the
554 passes that held the lock for more than 25 s, and over 14 days they covered
about 95% of the time a direct write (ADR 0042, 25 s wait) would have failed
`mailbox_busy`. On one new mailbox's first import, 192 of 213 passes held the lock
for more than 25 s.

New mail waited too. Of the 23 Inbox new-mail waits over 10 s in 14 days
(2,409 wakes), 21 sat behind same-account body work. In the hosted deployment
those wakes did not wait on the lock itself: its listener runs one pass at a
time, and a body follow-up pass ran ahead of the wake. The lock is what stopped
that host from running body work alongside, and it is what this decision frees.

Two more defects share the cause. After the first 1 MiB chunk a streamed body
has no deadline, so one slow download can hold the lock until the lock budget
ends. `fetchBody` writes without the write fence, and `markMessageGone`
tombstones by id alone.

## Decision

- The rule becomes: one mirror-changing operation per Mailbox Account at a time.
  A body download changes no mirror row, so it runs beside the lock on its own
  connection and commits under the lock. Attachment downloads already run beside
  the lock (ADR 0042).
- `MirrorEngine.syncBodies(accountId, { openClient?, clientAccountId?, signal?, maxMessages? })`
  is the sync body path; an action that files a message stores its body from
  its own bytes (ADR 0046). One run per Mailbox Account at a time: a run holds
  an account-scoped try-lock of its own for its whole duration, and a second run
  returns `remaining` without connecting. A run stores at most `maxMessages`
  bodies (`MAX_BODY_BATCHES_PER_TICK × BODY_BACKFILL_BATCH_SIZE` by default)
  and stops at `MAX_LOCK_HOLD_MS`; `remaining` says bodies may be left. A host
  that reuses a session passes `openClient`, called only once a body is due,
  and names its Mailbox Account. Shutdown closes the body connection. A unit is
  one bounded parsed-only UID-set fetch (up to 10 same-folder messages, 8 MiB)
  or one message. For each unit:
  1. **Read, no lock.** Live-window rows are read from `getBodyBacklog` before
     every unit, so a message that arrived during the run is next. In
     `metadata_and_bodies` mode and inside the backfill window, once no live row
     is due, archive rows follow, missing bodies before evidence upgrades; that
     arm sorts the whole mailbox, so it is read a page at a time. Both arms
     share the folder filters. An empty read opens no connection. A read is
     grouped by folder before the first unit is taken, so an interleaved backlog
     still batches.
  2. **Download, no lock.** The client selects the folder again
     (`invalidateSelection`), so it sees every UID stored before the read. A
     single-command unit is bounded by `IMAP_COMMAND_TIMEOUT_MS`; a streamed
     body is bounded, after its first chunk, by 60 s plus 8 KiB/s of declared
     size, at most 30 min, and never by more than what remains of the run's
     `MAX_LOCK_HOLD_MS` budget, so a run stays bounded whatever the provider's
     speed. On expiry the engine closes this connection and the run ends with
     `BodyDownloadTimeoutError`. A unit's result is all or nothing:
     a unit that fails, times out or is aborted stores no body and tombstones
     nothing. A command on a closed connection raises
     `ImapConnectionClosedError` (code `NoConnection`, a lost connection), never
     an empty result that would read as a gone message.
  3. **Commit, under the lock, as soon as the unit arrives.**
     `withInteractiveAccountLock` with `fenceWrites` keeps the downloaded rows
     that still exist, are not provider-deleted and are still due (no body yet,
     or outdated evidence); a body another path stored meanwhile is skipped,
     unless the refetch is forced. Then it writes, in the ADR 0028 order:
     evidence, `BodyStore.store`, `completeBodyStorage`. A message the provider
     reports gone is tombstoned only while its row still has the downloaded
     `(folder_path, uidvalidity, uid)`; a confirmed move keeps the row live, and
     the run ends with `remaining` so the next run reads it at its new UID.
- A row id is message identity and a confirmed move keeps it (ADR 0037), and
  every writer that deletes, resets or moves a row holds the lock (ADR 0042), so
  "exists, not deleted and still due" under the lock is the whole commit check.
- A unit that fails or times out is skipped by this engine with a doubling delay
  (1 min to 1 h), so one bad message cannot block the rest of the backlog. The
  delay lives in the engine process: a restart or another process retries at
  once, and the skipped ids ride along on the backlog read. When
  it is retried, each message of that unit downloads alone, so one bad message
  never keeps backing off the healthy messages that shared its unit. A restart
  retries at once. A truncated body still never retries on its own.
- `syncBodies` writes no sync run and no account state. A body error never marks
  the account failed; the run throws `BodySyncError` carrying what it stored,
  and the next run retries.
- A provider that refuses the body connection is recorded per Mailbox Account as
  a `BODY_CONNECTION_REFUSED` sync event with provider, host, response code and
  kind (`session_limit`, `login_refused`, `credentials_rejected`,
  `connection_closed` for a socket the server closed at login, or
  `connect_failed`), so a session cap shows by provider:
  `SELECT payload->>'provider', payload->>'host', payload->>'responseCode', count(*)
  FROM public.imap_sync_events WHERE event_type = 'BODY_CONNECTION_REFUSED'
  GROUP BY 1, 2, 3`.
- `syncAccount` fetches no bodies. Removed: the in-lock body lane,
  `bodyBacklogOnly` (passing it is `InvalidInputError`), the history inline body
  fetch, the history reason `body` and its scan, `getHistoricalBodyBacklog`,
  `skipMailboxLock`, `SyncResult.bodiesFetched` and the id-only
  `markMessageGone`. A sync run no longer counts bodies, so new
  `imap_sync_runs.bodies_fetched` values stay 0; body progress is
  `imap_account_progress` and the folder body counters. The column is dropped in
  a later release, once hosts stop reading it.
- `fetchBody(id, force)` downloads beside the lock, under the same one-run rule
  (`AccountBusyError` while a run holds it), and commits through the same
  fenced commit.
- `syncAccountWithBodies` runs the pass, then `syncBodies` (not after a failed
  or deferred pass), and reports a failed body run beside the recorded pass,
  with what it stored. The worker and CLI sync use it; REST sync takes one unit
  of bodies inside the request and leaves the rest to the worker. A host that
  keeps a listener runs `syncBodies` on a second connection.
- A live-change pass (`liveInboxOnly`) waits up to 5 s for the lock instead of
  trying once, so a wake queues behind one body commit rather than retrying
  into several. A full pass still tries once and defers.

## Consequences

- A sync pass holds the lock for metadata only. A direct write or a live-change
  pass waits for at most one body commit: database writes plus the body store
  write for one unit. Modeled from production timings, the time a write could
  fail `mailbox_busy` falls 15-20×, and a first import's passes stay inside
  25 s.
- For hosted new mail the gain comes only with the host change that runs
  `syncBodies` beside its listener loop; this record alone changes no hosted
  new-mail latency. Public core's bundled worker still runs accounts in series,
  so there new mail still follows a body run.
- First-import speed barely changes: units still download one after another and
  each unit's store still runs inside the commit hold. That is ADR 0047's work.
- A Mailbox Account uses one more provider session while bodies download. Known
  per-mailbox session limits: Rackspace 16, iCloud 10, Yahoo and AOL about 3;
  Purelymail publishes none. Whichever session logs in last is refused: that can
  be the body run (recorded as above; bodies wait), a pass or an action. Each
  body run that is due costs one more login per tick.
- A new message's body can wait behind the same account's unit in progress, up
  to its deadline. Its headers do not wait.
- A commit that waits 25 s for the lock ends the run and downloads the unit
  again next time.
- An object `BodyStore` uploads inside the commit hold, so a slow object store
  still lengthens the hold. Hosted parsed-only bodies are small objects; moving
  that upload out of the hold is a later choice.
- `max_backfill_rate` no longer governs archive bodies; `maxMessages` does.
- This amends ADR 0003, ADR 0008 and the three-lanes record: the lock still
  serializes every mirror write and every mailbox-changing IMAP command;
  read-only body downloads are the exception. ADR 0047 (text-first import)
  builds on this path: a text-only download mode inside `syncBodies`. ADR 0048
  (a pass gives way to a waiting write) is not needed once passes hold the lock
  for metadata only, and would conflict with this record: a body commit waits
  on the same key and would read as a waiting write.

## Verification

- Live DB: a body download held open does not block `syncAccount`; nothing is
  written before the commit lock.
- Live DB: a row deleted, reset, moved or stored by another path between
  download and commit is skipped or kept as the rules above say; a gone result
  after a move leaves the row live and the run reports `remaining`; a forced
  refetch replaces a stored body.
- Live DB: a second concurrent run stores nothing, opens no connection and
  reports `remaining`; folder counters count each body once.
- Live DB: a refused body connection records one `BODY_CONNECTION_REFUSED`
  event with provider, host and response code; the pass still succeeds.
- A trickling server hits the deadline; only the body connection closes, the
  run reports what it stored, and the next run skips that unit and fetches the
  rest; a failed multi-message unit's messages download alone next time.
- `syncAccount` and the history lane never fetch a body; `getHistoryBacklog` has
  no `body` reason; `getBodyBacklog` returns live rows before archive rows.
- Production, after the host change: passes over 25 s fall to the no-body
  baseline; `managed_idle_sync_runs` trigger-to-sync time during the next first
  import; `BODY_CONNECTION_REFUSED` events by provider; a deliberate draft save
  during an import waits under one unit.
