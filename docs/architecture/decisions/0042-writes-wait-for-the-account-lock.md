# ADR 0042: Direct writes wait for the account lock; a busy pass defers

Status: Accepted

## Problem

The account advisory lock gives one IMAP operation per Mailbox Account at a
time, but direct writes used it unevenly:

- Draft saves and sends took it with a single try. A sync holding it failed the
  write at once with `AccountBusyError`, even when the sync would finish in a
  second.
- Flag changes, moves, deletes and folder changes did not take it. A flag scan
  that read a message before an agent's STORE could write the old flags back
  over the write-through, and the mirror would show the wrong state until a
  later scan.
- A sync pass that found the lock held still opened a run. A live or Sent pass
  then recorded an empty `success`, and a full pass a `failed` "Account lock
  busy" run, though neither did any work.

A host that runs an agent's writes beside its own sync, instead of stopping the
sync first, hits all three on every write.

## Decision

- `withAccountLock` accepts `waitMs`. It then takes the lock with one blocking
  `pg_advisory_lock` statement under a statement timeout, and returns `null`
  when the timeout fires. Postgres queues the waiter ahead of later try-locks,
  so a writer waits for the current holder only. The lock statement is the first
  statement on its connection, so session-aware poolers route it as a lock.
- Every direct write runs under `withInteractiveAccountLock`, which waits up to
  25 seconds: draft create, update and send, send, delete, flag changes, moves,
  thread flags and moves, and folder create, rename and delete. Still held after
  the wait is `AccountBusyError`, raised before any provider command, as before.
- Draft update holds one lock across its APPEND and the old draft's delete.
  Callers that already hold the lock (draft update and send) delete through
  `deleteMessageInLock`; taking the lock again from a second session would wait
  on the caller itself.
- A sync pass opens its run only after it holds the lock. A pass that finds the
  lock held returns `outcome: "deferred"` with `runId: null`, writes no run and
  no account state, and the caller retries. A full pass through a session pooler
  still tries the stale-heartbeat recovery first.

## Consequences

- A sync can no longer interleave with a write, so a write-through cannot be
  undone by a pass that read the message earlier.
- A write may wait for the current sync step, and fails with `AccountBusyError`
  only after 25 seconds. Lower-lane passes can still hold the lock for up to
  `MAX_LOCK_HOLD_MS`, and priority folders may run past it, so a write during a
  long first sync can still be busy.
- A deferred pass leaves no trace in `imap_sync_runs`. A lock held for a long
  time shows as an account whose last finished sync grows old, not as a stream
  of failed runs.
- Attachment downloads still do not take the lock; they change no mirror row.
