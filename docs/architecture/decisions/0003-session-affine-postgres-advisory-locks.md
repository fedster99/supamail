# ADR 0003: Require Session-Affine Postgres For Account Locks

Status: Accepted

Date: 2026-05-18

## Context

SupaMail must never run concurrent IMAP operations for the same account. The worker and API may both initiate IMAP work, so serialization must work across processes. Postgres advisory locks are a good fit only when the database connection is session-affine.

Transaction poolers can break this guarantee because session-scoped locks may not remain attached to the expected backend session.

## Decision

Use session-scoped Postgres advisory locks as the account mutex, require direct/session-affine `DATABASE_URL`, reject obvious transaction-pooler URLs, and run a worker startup self-test that proves lock behavior. `withAccountLock` must persist an initial account heartbeat and prove through `pg_locks` that the same session still owns the advisory lock before provider work begins. Transient heartbeat errors are retried on that session; failure remains fail-closed. Operations that can approach the stale-reaper threshold refresh for the full lock lifetime and revalidate immediately before irreversible work. After a caller confirms an irreversible action, later liveness or unlock failures become success diagnostics rather than retry signals.

Unlock is also a proof obligation: `pg_advisory_unlock` must return true. A false result or query error causes `pg.Pool` to evict/destroy that client so a possibly lock-owning session is never returned to the pool.

### Amendment: no live-lock takeover (2026-09)

Recovery no longer terminates a lock-holding session whose heartbeat is stale. A stale heartbeat cannot distinguish a dead worker from a frozen one. A frozen worker that resumes after losing its lock could write stale mailbox state with no database fence. Instead, every pooled session sets server-side TCP keepalive and `tcp_user_timeout`. Postgres then releases the sessions of a vanished worker in about a minute, while a stalled but alive worker keeps its locks. Sync proves ownership with `assertLive` at folder and history-batch boundaries and stops on loss. Startup cleanup touches only accounts whose lock no session holds.

## Consequences

- Supabase transaction pooler URLs are not supported.
- Supabase session pooler URLs on port `5432` are acceptable when direct IPv6 connectivity is unavailable.
- Lock-sensitive code must not switch to `pg_advisory_xact_lock`.
- Worker startup fails fast if lock semantics are unsafe.
- Provider work never starts when the initial lock heartbeat cannot be persisted.
- Known-lost/unknown lock liveness cannot cross an irreversible boundary.
- No live lock holder is ever terminated; contention reports "Account lock busy".
- Through a session pooler, server-side probes reach the pooler, so a vanished
  worker's locks persist until the pooler drops that client.
- Confirmed delivery is never converted into a retry signal by later heartbeat or
  unlock diagnostics.
- Failed/false advisory unlock destroys the pool session; it cannot leave a
  re-entrant lock hidden in an idle client.
- Live DB tests are required for lock behavior changes.

## Verification

- `apps/api/src/db.ts` rejects transaction-pooler URLs and allows direct/session-pooler URLs.
- `apps/api/src/locks.ts` implements `withAccountLock` and `runLockSelfTest`.
- `apps/api/src/worker.ts` runs the lock self-test on startup.
- `send.live-db.test.ts` holds a send beyond the stale threshold and proves its
  heartbeat stays fresh for the whole send.
- `sync-engine.live-db.test.ts` proves a stale-heartbeat holder and a slow live
  sync are never taken over, lost ownership stops further folder writes, and
  every pooled session has the TCP liveness settings.
- The same live suite fault-injects `unlock=false`, then proves another real
  Postgres session can acquire the lock after the faulty client is evicted.
- `pnpm test:db:live` exercises advisory lock behavior against real Postgres.

## References

- `docs/spec-conformance.md`
- `apps/api/src/db.ts`
- `apps/api/src/locks.ts`
- `apps/api/scripts/test-db-live.ts`
