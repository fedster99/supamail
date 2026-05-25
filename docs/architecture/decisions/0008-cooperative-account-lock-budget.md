# ADR 0008: Enforce Account Lock Budget Cooperatively

Status: Accepted

Date: 2026-05-23

## Context

`MAX_LOCK_HOLD_MS` existed in configuration but was not enforced. That left large or slow accounts able to hold the account advisory lock for longer than intended, especially once body backfill and historical backfill share the same lock.

Hard cancellation is risky for IMAP. Interrupting a `FETCH` midway can leave the connection in an ambiguous state and can make cursor advancement harder to reason about. The engine already persists progress at folder, metadata-batch, body-batch, and reconcile boundaries, so the safe enforcement point is between those boundaries.

## Decision

Enforce `MAX_LOCK_HOLD_MS` as a cooperative lock budget:

- `syncAccount` computes a lock deadline immediately after acquiring the advisory lock.
- Priority folders still get processed even if the deadline has already been reached, and priority folders are not interrupted inside their folder work.
- Non-priority folders check the deadline before starting and between metadata/reconcile batches.
- Body backlog fetch checks the deadline between batches and is capped by `MAX_BODY_BATCHES_PER_TICK`.
- `SyncResult.hitLockBudget` records that the cycle reached the budget.
- A budget-hit success or partial success is neutral for backoff counters. It does not count as a failure, but it also does not increment success counters or clear stored backoff.

## Consequences

- Slow accounts release the advisory lock at predictable safe points.
- Fresh priority mail continues to win over fairness when those goals conflict.
- Body fetching cannot consume unbounded tick time before historical backfill exists.
- The budget is not a hard wall-clock guarantee. A single in-flight priority folder can overrun it, bounded by the existing IMAP operation deadlines.

## Verification

- `apps/api/src/__tests__/sync-engine.integration.test.ts` Scenario G.1 proves priority folders still process after the deadline while lower-priority folders are skipped.
- Scenario G.2/G.3 proves non-priority incremental sync exits after a batch and leaves backoff counters unchanged.
- The body cap test proves `MAX_BODY_BATCHES_PER_TICK` limits body backlog draining.
- `pnpm test:db:live` runs the DB-backed integration suite and spec conformance.

## References

- `docs/architecture/reliability-and-three-lanes.md` D5
- `apps/api/src/sync-engine.ts`
- `apps/api/src/repository.ts`
