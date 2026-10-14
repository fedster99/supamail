# ADR 0044: Release the Account Lock Every 20 s and Let Sends Wait for It

Status: Accepted

Date: 2026-10-13

## Context

Every IMAP operation on a Mailbox Account holds one session advisory lock
(ADR 0003). ADR 0008 bounded a pass's hold with `MAX_LOCK_HOLD_MS`, which was
10 minutes by default, and let priority folders finish past it. Two things
followed from that:

- A backfill pass could hold the lock for 10 minutes or more.
- Sends and draft saves took the lock without waiting, so during that time
  they failed at once with `AccountBusyError`. A live pass behind a backfill
  yielded and waited for its next turn.

A full pass that found the lock busy recorded a failed run, and a single-lane
pass recorded an empty success. Neither described what happened: nothing ran.

## Decision

- **A 20 s budget, for every folder.** `MAX_LOCK_HOLD_MS` defaults to 20 s and
  may not exceed it. A pass starts no new chunk once it has held the lock that
  long, in every mode, and priority folders no longer skip the budget. Unfinished
  work stays due or different, so the next pass continues it.
- **One chunk always finishes.** The budget counts only after a chunk completes,
  so a slow login or discovery cannot leave every pass without progress. A
  chunk is one of:
  - a metadata batch or an initial-sync batch;
  - a body or a parsed body batch;
  - a history batch or a reconcile backfill batch;
  - a flag scan or a QRESYNC replay.
- **The flag-scan exception.** A flag scan is one chunk with its own deadline
  (`FLAG_SCAN_TOTAL_TIMEOUT_MS`), because it has no resume point. Without a
  modseq, the whole-window flag scan rides with the scheduled audit and stays
  due until that audit runs, so the audit follows it past the budget.
- **Bounded waits.** `withAccountLock` accepts `waitMs`. It waits in Postgres
  with `pg_advisory_lock` under a transaction-scoped `lock_timeout`. A
  `statement_timeout` above that wait keeps a role default from cutting it
  short. The transaction commits as soon as the session lock is granted.
  Postgres grants a queued request ahead of the holder's next try, so the
  waiter gets the lock at the holder's next chunk boundary.
  - Sends, draft saves, and draft sends wait up to `ACCOUNT_LOCK_WAIT_MS`
    (25 s, and at most 25 s).
  - A pass waits only when its host sets `waitForLock`, for a live pass behind
    the host's own lower lane.
  - The lock-liveness proof before SMTP and APPEND, and durable send
    (ADR 0041), are unchanged.
- **A busy lock is a typed deferral.** When another session holds the lock,
  `syncAccount` throws `AccountBusyError` (HTTP 503 with `Retry-After`). A pass
  records its run only after it holds the lock, so a deferral leaves no run and
  no account state. The worker's loops skip a deferred account. A full pass
  through a session pooler keeps its stale-heartbeat takeover before deferring.

## Consequences

- A send during a long backfill waits for at most one chunk boundary instead of
  failing. It still fails with `AccountBusyError` if the lock stays held past
  the wait.
- New mail behind a lower lane waits for one chunk boundary when the host passes
  `waitForLock`.
- A pass doing a large whole-window flag scan can still hold the lock for up to
  `FLAG_SCAN_TOTAL_TIMEOUT_MS` (plus the audit it carries). Bounding it needs
  resumable flag scans with durable progress, which is a separate decision.
- Hosts must treat `AccountBusyError` from `syncAccount` as a deferral, not a
  failure.
- Backfill takes more, shorter passes. Each pass still has the same per-pass
  caps, so total work is unchanged.

## Verification

`pass-lock-release.live-db.test.ts` proves:

- a waiting lock request wins over the holder's immediate retry;
- a bounded wait ends as busy and leaves the session's timeouts unchanged;
- a send gets the lock between back-to-back history chunks, well inside its
  bound;
- a live pass waits for a lower lane, and defers past the bound without a run;
- Inbox stops at the budget and later passes finish the work;
- first sync and the body lane finish one chunk under a spent budget;
- an audit follows its whole-window flag scan past the budget;
- a pass that escapes after taking the lock closes its run as failed.

The send and draft live tests run their contention cases through the wait.

## References

- ADR 0003: session-affine Postgres advisory locks.
- ADR 0008: cooperative account-lock budget (amended).
- ADR 0017: send primitive; ADR 0019: drafts (busy handling amended).
- ADR 0023: Sent freshness lane (lock contention amended).
- ADR 0043: every pass records mailbox state.
- `apps/api/src/locks.ts`, `apps/api/src/sync-engine.ts`, `apps/api/src/send.ts`,
  `apps/api/src/drafts.ts`
