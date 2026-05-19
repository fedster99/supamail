# ADR 0004: Reconcile Provider UIDs Through A Temp Table

Status: Accepted

Date: 2026-05-18

## Context

Reconciliation compares provider-visible UIDs against local rows. Large mailboxes can expose 100k or more UIDs. Passing all provider UIDs as a single SQL array increases Node memory pressure and can exceed parameter/encoding limits.

## Decision

Stream provider UIDs into a transaction-scoped Postgres temp table with `ON COMMIT DROP`, then compare local rows against that temp table.

## Consequences

- Reconcile can handle large folders without building one giant array in application memory.
- Cleanup is transaction-scoped.
- Reconcile code depends on live Postgres behavior and must be covered by the live DB lane.

## Verification

- `MirrorRepository.markMissingMessagesFromLiveUidStream` creates and uses the temp table.
- `pnpm test:db:live` covers reconcile backfill and provider-missing behavior.
- `pnpm spec-conformance` runs as part of the live DB lane.

## References

- `src/repository.ts`
- `scripts/spec-conformance.ts`
- `scripts/test-db-live.ts`
