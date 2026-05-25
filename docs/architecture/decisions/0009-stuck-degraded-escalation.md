# ADR 0009: Escalate Stuck Degraded Accounts With Retryable Broken State

Status: Accepted

Date: 2026-05-24

## Context

`DEGRADED` is a retryable health state, but an account that stays degraded for a long time without any successful priority sync needs operator-visible escalation. Treating every retry as a normal transient failure is also wrong: exponential backoff can hide the account for longer and longer when the desired behavior is an hourly recovery probe.

## Decision

Add `imap_accounts.last_priority_sync_succeeded_at` and update it when a success or partial success proves priority folders succeeded.

When a degraded account has not had a priority success for `STUCK_DEGRADED_BROKEN_THRESHOLD_MS`:

- mark it `BROKEN` with `sync_state_reason = 'STUCK_DEGRADED_24H'`;
- schedule the next retry through `backoff_until = now() + STUCK_DEGRADED_RETRY_INTERVAL_MS`;
- do not increment `consecutive_failures` or compound `current_backoff_ms`.

`getRunnableAccounts` returns this specific broken reason after `backoff_until` elapses. If the account still has no priority success after `STUCK_DEGRADED_TERMINAL_THRESHOLD_MS`, mark it `BROKEN` with `sync_state_reason = 'STUCK_DEGRADED_TERMINAL'` and clear `backoff_until`.

## Consequences

- Long-stuck degraded accounts become visible as broken without losing retry behavior.
- Retry cadence is stable and operator-readable instead of hidden behind exponential backoff.
- Terminal stuck-degraded accounts require manual operator action before scheduling resumes.
- Successful priority sync clears the stuck-degraded state by updating `last_priority_sync_succeeded_at`.

## Verification

- `apps/api/src/__tests__/sync-engine.integration.test.ts` Scenario I proves retryable escalation, runnable retry, recovery, terminal cutoff, and manual clear scheduling.
- `apps/api/scripts/spec-conformance.ts` Scenario I proves the same behavior against real Postgres.
- `pnpm test:db:live` runs the migration, live integration suite, and spec conformance.

## References

- `apps/api/src/repository.ts`
- `apps/api/supabase/migrations/public/0002_stuck_degraded_escalation.sql`
- `docs/architecture/reliability-and-three-lanes.md` D7
