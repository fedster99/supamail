# ADR 0005: Use A Live DB Reliability Lane For Postgres Semantics

Status: Accepted

Date: 2026-05-18

## Context

Many SupaMail correctness properties depend on real Postgres behavior: advisory locks, migration idempotence, temp tables, `pg_locks`, health-state updates, retention, and reconcile queries. Unit tests and source-string checks are useful, but they cannot prove those database semantics.

## Decision

Maintain a separate live DB reliability lane. `pnpm test:db:live` first proves
the disposable Docker lifecycle across success, failure, `SIGINT`, `SIGTERM`,
and parallel runs. It then provisions disposable Docker Postgres, applies the
migration twice, runs DB-backed sync engine suites, runs spec conformance, and
cleans up the exact container and named volume unless `KEEP_DB=1` is set.

Normal `pnpm test` stays fast and does not require Docker or `DATABASE_URL`.

## Consequences

- Sync, repository, lock, migration, schema, reconcile, retention, and health changes require the live DB gate.
- CI has a separate live DB job, so failures identify reliability regressions instead of blending into fast unit tests.
- Agents must treat live DB failures as product bugs, not test-workaround opportunities.

## Verification

- `apps/api/scripts/test-db-live.ts` provisions and tears down the disposable Postgres container.
- `apps/api/scripts/test-ephemeral-postgres-lifecycle.ts` compares labeled Docker
  containers and volumes before and after every lifecycle scenario.
- `package.json` exposes `pnpm test:db:live`.
- `.github/workflows/ci.yml` runs a separate Live DB Reliability job.
- `docs/agent/verification.md` maps reliability-sensitive changes to this gate.

## References

- `apps/api/scripts/test-db-live.ts`
- `apps/api/scripts/spec-conformance.ts`
- `.github/workflows/ci.yml`
- `docs/agent/verification.md`
- PR #5 owner comments.
