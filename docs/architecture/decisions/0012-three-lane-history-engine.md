# ADR 0012: Three-Lane History Engine

Status: Accepted

Date: 2026-05-24

## Context

Historical backfill can be much larger and slower than the live mailbox window. Running it as a separate worker or connection would violate the account-level invariant: one IMAP operation per account at a time. Running it before hot sync or live body fetches would let old mail starve fresh mail and search-critical priority bodies.

PRs 1-7 made the shared account lock safe enough for this work: cooperative lock budgeting, bounded body batches, per-account history settings, and progress roll-ups are now in place.

## Decision

Use one advisory-lock acquisition with three ordered lanes:

1. Hot lane: folder discovery, live-window initial/incremental sync, flag scans, and reconcile.
2. Body lane: capped live body backlog fetch.
3. History lane: resumable older-than-window metadata and optional body backfill.

The history lane consumes `historical_backfill_mode`, `archive_refresh_interval`, `archive_flag_sync`, and `max_backfill_rate`. It uses the existing `imap_folders.backfill_*` state plus `last_archive_refresh_at` to record snapshots, watermarks, and periodic archive refresh completion.

History work is skipped when the hot/body lanes exhaust the cooperative lock budget. `max_backfill_rate` limits history batches per lock acquisition: `small` runs one batch, `normal` runs three, and `aggressive` runs until the lock budget stops it.

## Consequences

- Fresh mail and live body search reliability stay ahead of deep archive completeness.
- Historical backfill is automatic, resumable, and observable through the existing progress counters/view.
- `historical_backfill_mode = 'off'` disables history work for accounts that only want the live mirror.
- Archive refresh is intentionally light. It re-runs the history snapshot path on the configured cadence; deeper historical delete reconciliation remains a future operational layer.

## Verification

- `apps/api/src/__tests__/sync-engine.integration.test.ts` Scenario L proves lane order and budget skipping.
- `apps/api/scripts/spec-conformance.ts` Scenario L proves the same behavior against real Postgres state.
- `pnpm test:db:live` runs the DB-backed integration suite and spec conformance.

## References

- `docs/architecture/reliability-and-three-lanes.md` D2/D5/D6
- `apps/api/src/sync-engine.ts`
- `apps/api/src/repository.ts`
- `apps/api/supabase/migrations/public/0006_history_lane_state.sql`
