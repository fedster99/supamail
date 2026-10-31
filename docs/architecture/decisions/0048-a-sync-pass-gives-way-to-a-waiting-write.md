# ADR 0048: A sync pass gives way to a waiting write

Status: Accepted

Date: 2026-10-31

## Context

ADR 0042 made every direct write wait up to 25 seconds for the account lock and
noted the remaining gap: a pass may hold the lock much longer, so a write during
a long first sync can still fail with `AccountBusyError`.

A hosted deployment measured that gap on a new Mailbox Account. In its first
4 h 41 min, 192 of 213 passes held the lock for more than 25 seconds, and the
lock was held for 81% of the wall time. An agent's draft save, move, send or
flag change arriving at a random moment would have failed about half the time.
No write happened to arrive during that import, so the failure was latent.

## Decision

- The liveness check a pass already runs before each folder, body batch and
  history batch also reports whether another session is waiting for this
  account's lock: a non-granted advisory lock on the same key in `pg_locks`. It
  is part of the same query, so it costs no extra round trip. Only
  `withInteractiveAccountLock` waits for the lock; sync passes try-lock, so a
  waiter is a direct write.
- `AccountLock.writerWaiting()` returns what the last check saw.
- At those boundaries, once the pass has started one unit, a waiting write ends
  the pass: it starts no further folder, body batch or history batch. Postgres
  hands the lock to the queued waiter on release, ahead of later try-locks.
- The pass reports `yieldedToWriter`, recorded in the run's metadata. Like a
  spent lock budget, it is a normal completion, not a failure, and it does not
  count toward backoff. Folders it did not reach stay due, and mailbox changes
  for them stay unacknowledged.

## Consequences

- A direct write waits for the unit in flight, not the whole pass. A unit is one
  folder step, one body batch of `BODY_BACKFILL_BATCH_SIZE` messages, or one
  history batch; a host keeps those well inside 25 seconds. Downloading a single
  very large message can still take longer.
- A stream of writes ends a pass after each unit. Each pass still makes
  progress, so an import slows down but never stalls.
- A host that continues a pass on `hitLockBudget` must also continue it on
  `yieldedToWriter`.

## Verification

- `interactive-lock.live-db.test.ts`: the holder sees a waiting direct write,
  and not a try-lock or a write waiting for another mailbox.
- `sync-engine.integration.test.ts` Scenario G.4: a write that starts waiting
  during the first folder gets the lock after that folder; the pass records
  `yieldedToWriter`, leaves backoff counters unchanged, and the next pass
  syncs the folder it left.

## References

- ADR 0008, 0042
- `apps/api/src/locks.ts`, `apps/api/src/sync-engine.ts`
