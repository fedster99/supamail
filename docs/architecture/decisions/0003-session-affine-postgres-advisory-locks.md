# ADR 0003: Require Session-Affine Postgres For Account Locks

Status: Accepted

Date: 2026-05-18

## Context

SupaMail must never run concurrent IMAP operations for the same account. The worker and API may both initiate IMAP work, so serialization must work across processes. Postgres advisory locks are a good fit only when the database connection is session-affine.

Transaction poolers can break this guarantee because session-scoped locks may not remain attached to the expected backend session.

## Decision

Use session-scoped Postgres advisory locks as the account mutex, require direct/session-affine `DATABASE_URL`, reject obvious transaction-pooler URLs, and run a worker startup self-test that proves lock behavior.

## Consequences

- Supabase transaction pooler URLs are not supported.
- Lock-sensitive code must not switch to `pg_advisory_xact_lock`.
- Worker startup fails fast if lock semantics are unsafe.
- Live DB tests are required for lock behavior changes.

## Verification

- `apps/api/src/db.ts` rejects pooler-looking URLs.
- `apps/api/src/locks.ts` implements `withAccountLock` and `runLockSelfTest`.
- `apps/api/src/worker.ts` runs the lock self-test on startup.
- `pnpm test:db:live` exercises advisory lock behavior against real Postgres.

## References

- `docs/spec-conformance.md`
- `apps/api/src/db.ts`
- `apps/api/src/locks.ts`
- `apps/api/scripts/test-db-live.ts`
