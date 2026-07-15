# ADR 0003: Require Session-Affine Postgres For Account Locks

Status: Accepted

Date: 2026-05-18

## Context

SupaMail must never run concurrent IMAP operations for the same account. The worker and API may both initiate IMAP work, so serialization must work across processes. Postgres advisory locks are a good fit only when the database connection is session-affine.

Transaction poolers can break this guarantee because session-scoped locks may not remain attached to the expected backend session.

## Decision

Use session-scoped Postgres advisory locks as the account mutex, require direct/session-affine `DATABASE_URL`, reject obvious transaction-pooler URLs, and run a worker startup self-test that proves lock behavior. `withAccountLock` must persist an initial account heartbeat and prove through `pg_locks` that the same session still owns the advisory lock before provider work begins. Transient heartbeat errors are retried on that session; failure remains fail-closed. Operations that can approach the stale-reaper threshold refresh for the full lock lifetime and revalidate immediately before irreversible work. After a caller confirms an irreversible action, later liveness or unlock failures become success diagnostics rather than retry signals.

Unlock is also a proof obligation: `pg_advisory_unlock` must return true. A false result or query error causes `pg.Pool` to evict/destroy that client so a possibly lock-owning session is never returned to the pool.

## Consequences

- Supabase transaction pooler URLs are not supported.
- Supabase session pooler URLs on port `5432` are acceptable when direct IPv6 connectivity is unavailable.
- Lock-sensitive code must not switch to `pg_advisory_xact_lock`.
- Worker startup fails fast if lock semantics are unsafe.
- Provider work never starts when the initial lock heartbeat cannot be persisted.
- Known-lost/unknown lock liveness cannot cross an irreversible boundary.
- Long outbound sends cannot be reaped as stale while still holding a live lock.
- Confirmed delivery is never converted into a retry signal by later heartbeat or
  unlock diagnostics.
- Failed/false advisory unlock destroys the pool session; it cannot leave a
  re-entrant lock hidden in an idle client.
- Live DB tests are required for lock behavior changes.

## Verification

- `apps/api/src/db.ts` rejects transaction-pooler URLs and allows direct/session-pooler URLs.
- `apps/api/src/locks.ts` implements `withAccountLock` and `runLockSelfTest`.
- `apps/api/src/worker.ts` runs the lock self-test on startup.
- `send.live-db.test.ts` holds a send beyond the stale threshold and proves the
  orphan reaper leaves its periodically refreshed lock untouched.
- The same live suite fault-injects `unlock=false`, then proves another real
  Postgres session can acquire the lock after the faulty client is evicted.
- `pnpm test:db:live` exercises advisory lock behavior against real Postgres.

## References

- `docs/spec-conformance.md`
- `apps/api/src/db.ts`
- `apps/api/src/locks.ts`
- `apps/api/scripts/test-db-live.ts`
