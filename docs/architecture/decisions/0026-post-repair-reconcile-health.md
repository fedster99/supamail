# ADR 0026: Reconcile Health Describes Post-Repair State

Status: Accepted

Date: 2026-07-14

## Context

A reconcile pass can observe normal provider drift and repair it immediately. A message
moved or deleted at the provider is tombstoned in the mirror during the UID comparison;
a provider UID missing from the mirror is fetched and upserted during the same pass.

The engine previously set `last_reconcile_clean = false` whenever it observed either
kind of gap, even when every gap had already been repaired. Account health therefore
reported `DEGRADED` with `RECONCILE_GAPS_FOUND` until the next reconcile, normally six
hours later. That conflated evidence about the pre-pass state with a claim about the
post-pass state.

## Decision

- `reconcile_gaps_found` records the bounded number of gaps observed at the start of a
  reconcile repair. It remains useful run telemetry and does not by itself determine
  account health.
- `last_reconcile_clean` describes the mirror after the pass. It is true when all
  provider-missing local rows were tombstoned, every returned missing-in-DB UID was
  fetched and upserted, the account lock budget did not interrupt the pass, and the
  bounded missing-UID query did not overflow.
- Missing-in-DB repair remains capped at 5,000 UIDs per pass. The query reads one
  sentinel row beyond that cap so overflow is explicit rather than silently treated as
  complete.
- An interrupted or overflowed repair remains unclean and schedules reconcile for the
  next full-sync cadence. A clean pass returns to the normal reconcile interval.

## Consequences

Accounts recover to `HEALTHY` in the same successful run that repairs ordinary mailbox
drift. Operators still retain evidence that gaps were found through the sync-run count.
Incomplete repair stays visibly `DEGRADED` and retries promptly instead of waiting the
normal six-hour interval. No schema or public API change is required.

## Verification

Live-Postgres tests prove that provider-side deletion is tombstoned while the account
finishes healthy, missing-in-DB backfill finishes healthy, 5,001 missing UIDs expose
overflow, and an unclean pass schedules an early retry.

## References

- `apps/api/src/sync-engine.ts`
- `apps/api/src/repository.ts`
- `apps/api/src/__tests__/sync-engine.live-db.test.ts`
- `docs/agent/reliability-invariants.md`
