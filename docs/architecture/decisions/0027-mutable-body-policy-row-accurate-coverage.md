# ADR 0027: Mutable Body Policy and Row-Accurate Live Coverage

Status: Accepted

Date: 2026-07-23

## Context

`body_fetch_policy` controls which live-window messages enter the automatic body
lane. The API accepted the policy at account creation, but it could not change
the policy for an existing account. A consumer that needed complete live-window
bodies therefore could not move an account from `priority_then_backfill` to
`immediate` without recreating it or writing SQL directly.

The live and priority body percentages in `imap_account_progress` were derived
from cumulative folder counters and the initial live-window snapshot. Those
counters are useful telemetry, but they do not describe the current active row
set. New messages after the snapshot, provider deletions, and truncated body
rows can make a counter-based percentage claim full coverage when current
messages are still incomplete.

## Decision

- `PATCH /accounts/:id/settings` accepts `bodyFetchPolicy` with exactly
  `immediate`, `lazy`, or `priority_then_backfill`. It persists the value and
  returns the updated account. The endpoint remains strict: invalid values,
  empty input, and unknown fields are rejected. `live_window_days` remains
  immutable.
- `priority_then_backfill` means that the live body lane fetches only priority
  folders. It does not promise a later live-body pass for current messages in
  non-priority folders. Historical backfill remains a separate, older-than-window
  lane.
- `imap_account_progress` derives live and priority body targets from current
  `imap_messages` rows that are in `IN_WINDOW`, not deleted at the provider, and
  in tracked folders whose `missing_since` is NULL and whose status is neither
  `MISSING` nor `PENDING_VERIFICATION`. Priority targets additionally require
  `sync_priority <= 10`.
- A live body counts as complete only when its `imap_message_bodies` row exists
  and `raw_truncated = false`. A complete `parsed_only` body still counts even
  when `raw_mime` is NULL.
- A truncated body remains visible as incomplete coverage, but it does not enter
  an automatic retry loop. An explicit body refetch is useful after the cause is
  corrected. A cap-limited message requires a higher `BODY_RAW_MAX_BYTES`
  before retry.
- `GET /accounts/:id` exposes row-current
  `live_bodies_fetched_count` and `live_bodies_target_count` for each folder.
  Per-folder `bodies_pct` uses those fields instead of the cumulative body
  counter. Folder rows include untracked, missing, and pending folders, while
  the account roll-up excludes them. Their targets therefore need not sum to
  the account target.
- Incremental folder counters remain cumulative telemetry and continue to
  support header and historical progress. They are not the source of truth for
  current live or priority body completeness.
- Migration `0021_row_accurate_body_progress` adds the partial
  `imap_messages_live_body_progress_idx` on `(account_id, folder_path, id)` for
  rows where `deleted_in_provider = false` and
  `window_status = 'IN_WINDOW'`. Large existing mirrors must create this exact
  index concurrently before applying the transactional migration.

## Consequences

An existing account can move to `immediate` and let the next normal body-lane
passes drain missing live bodies from all tracked folders. It can also move to
`lazy` or back to `priority_then_backfill` without account recreation.

Live body percentages can decrease when a new current message arrives and
increase when its complete body is stored. They can also improve when an active
message leaves the tracked live set. This is correct: the percentage is a claim
about current evidence, not a monotonic job counter.

Fresh and small databases can let the migration create the partial index
transactionally. A large existing mirror needs an operator preflight so index
construction does not extend the migration transaction:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS imap_messages_live_body_progress_idx
  ON public.imap_messages (account_id, folder_path, id)
  WHERE deleted_in_provider = false
    AND window_status = 'IN_WINDOW';
```

Truncated downloads cannot produce false 100 percent coverage. They also cannot
consume every worker cycle through automatic retries. Operators and consumers
must correct the cause before they use the explicit refetch path for another
attempt.

## Verification

- API tests cover every accepted policy and reject invalid, empty, and unknown
  settings input.
- Repository tests prove that the policy is persisted and the updated account is
  returned.
- Schema tests pin the security-invoker view, current-row filters, complete-body
  predicate, and browser-role revocations.
- Real-Postgres Scenario R proves that a message added after the initial snapshot
  expands the live target and that a truncated body remains incomplete even when
  cumulative folder counters report both fetch attempts.
- Real-Postgres Scenario S proves that a current non-priority body stays out of
  `priority_then_backfill`, then becomes eligible on the first sync after the
  settings API changes the policy to `immediate`.

## References

- `apps/api/src/api.ts`
- `apps/api/src/repository.ts`
- `apps/api/supabase/migrations/public/0021_row_accurate_body_progress.sql`
- `apps/api/src/__tests__/api-safety.test.ts`
- `apps/api/src/__tests__/sync-engine.integration.test.ts`
- `docs/architecture/reliability-and-three-lanes.md`
