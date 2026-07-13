# ADR 0023: Bounded Sent Freshness Lane

Status: Accepted

Date: 2026-07-12

## Context

Outbound messages are a high-value freshness signal for consumers that detect
relationship activity and communication outages. Sent was already priority 5,
but it shared the minute-scale full sweep and the bounded priority-folder set.
A provider exposing many higher-priority INBOX aliases could crowd Sent out, and
shortening the whole worker interval would multiply discovery, reconcile, body,
history, and account-health work.

## Decision

Reserve Sent a slot when selecting the bounded priority set, then restore normal
priority order for full-sweep execution. Interleave a second, due-based Sent-only
lane at `SENT_SYNC_INTERVAL_MS` (30 seconds by default) between the existing
`SYNC_INTERVAL_MS` full sweeps.

The Sent lane uses the same advisory account lock, mailbox lock, command timeout,
and IMAP throttle as every other sync operation. It updates metadata only and
skips folder discovery, flag scans, reconcile, body backlog, and history. It
finishes its durable sync run and releases `currently_syncing`, but does not update
the account's full-sweep `last_sync_finished_at` or claim that full-account
health/backoff was recomputed; the next full sweep owns those transitions.

## Consequences

- Sent metadata is normally observed in 30-60 seconds instead of 1-2 minutes and
  cannot be starved by a crowded priority set.
- The extra pass adds a bounded Sent mailbox metadata check, not another full
  mailbox sweep. Body/history throughput and reconcile rates remain unchanged.
- Accounts without due Sent work are filtered before lock acquisition, IMAP
  connection, or sync-run creation, avoiding no-op write and connection churn.
- Deployments can tune or effectively disable the faster lane by setting
  `SENT_SYNC_INTERVAL_MS` at or above `SYNC_INTERVAL_MS`.
- Fast-lane failures remain visible in durable sync runs and worker error logs;
  full sweeps retain authority over health and retry/backoff state.

## Verification

- Config tests pin the 30-second default and override behavior.
- Worker tests pin full/Sent lane interleaving and ensure a slower Sent setting
  never delays the full sweep.
- Live Postgres tests prove Sent reserves a bounded priority slot and receives a
  shorter `next_sync_due_at` than INBOX.
- Sync integration proves the fast pass processes only Sent, skips body backlog,
  leaves other due work queued, and does not refresh the full-priority health
  timestamp.

## References

- `apps/api/src/worker-runtime.ts`
- `apps/api/src/sync-engine.ts`
- `apps/api/src/repository.ts`
- ADR 0008: cooperative account-lock budget.
- ADR 0012: three-lane history engine.
