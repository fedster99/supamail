# Reliability Hardening and Three-Lane Engine — Design Plan

Status: Accepted. Drafted 2026-05-22 from a design grilling session.

This is a multi-decision plan, not an ADR. Individual decisions in this doc will be promoted to ADRs as they ship. Until then, this is the single source of truth for the v0.2 reliability and historical-backfill work.

## Why This Doc Exists

Two motivating findings:

1. **Conformance audit** against the original Rackspace/Signal sync spec found three drifts where load-bearing safeguards were defined in config or implied by the spec but never enforced in code: `MAX_LOCK_HOLD_MS`, an initial-sync stall timeout, and the "stuck DEGRADED for 24h → BROKEN" transition. The first two became more urgent once we committed to historical backfill, which holds locks longer and fetches in big batches.
2. **Issue-2 (historical backfill)** cannot land safely on top of the current engine. Adding a backfill lane that shares the account advisory lock and runs alongside hot sync requires the lock budget to be real, not a config slot nobody reads.

The grilling resolved both into a single coherent plan: ship the reliability hardening first as the foundation, then build historical backfill on top as the three-lane engine.

## Operating Contract After This Plan Lands

To the user / API consumer:

> Your email shows up in the database within minutes. Bodies for INBOX and Sent are usually current within hours. Bodies for older folders fill in over days, then weeks for the deep archive. We never lose an email. Search reliability scales with body completeness, and progress columns tell you what to trust at any moment.

To agents / contributors:

> One Postgres advisory lock per account. Inside that lock, three priority-ordered lanes: hot (fresh metadata) → body (recent bodies) → history (older mail). Hot lane completion gates HEALTHY. Body lane completion gates search reliability. History lane never determines health.

## Decisions

### D1: Reliability hardening is a pre-requisite for historical backfill

Issue-2 holds locks longer and fetches in larger batches than the current hot-only engine. The four spec-listed reliability gaps (`MAX_LOCK_HOLD_MS` enforcement, initial-sync stall timeout, stuck-degraded escalation, folder-count cap / reactive rediscovery) ship before the history lane is wired.

The historical backfill feature in `docs/agent/feature-list.json` (`issue-2-historical-backfill`) becomes blocked-by this reliability work. PRs land in the order in §PR Sequence below.

### D2: One advisory lock, three priority-ordered lanes per acquisition

Spec §1 invariant stands: "Do not run two concurrent IMAP operations for the same account." There is no second worker, no second connection, no second advisory lock. The three lanes share `withAccountLock` and execute in priority order during a single lock acquisition:

```text
take advisory lock
  → hot lane: discover (if due), sync due folders (initial or incremental), reconcile
  → body lane: drain body backlog (priority folders first, newest-UID first)
  → history lane: backfill older mail in resumable batches
release advisory lock
```

The lanes are conceptual scheduling phases, not separate state machines. Each phase reads its own due-state from the schema and writes its own progress. Lane state is mostly already present in `imap_folders` (the `backfill_*` columns were added in `0001_imap_mirror.sql` but never wired).

### D3: "Ready" means live-window headers complete

A new account is considered "onboarded" when live-window metadata (headers + envelopes + flags + folder state) is complete. Bodies and history fill in progressively. This commits to honest framing in product copy and in the API contract.

- `sync_state = 'HEALTHY'` requires: live-window headers complete, priority-folder bodies current, reconcile clean. History lane state does NOT affect `sync_state`.
- Search lives downstream of SupaMail. SupaMail's job is to surface completeness clearly so search consumers can degrade gracefully. SupaMail does not implement search.
- `live_window_days` is immutable after account creation in v0.1. Changing it requires a migration story we haven't built.

### D4: Progress signal — incremental per-folder counters, per-account roll-up via view

Per-folder counters live as **columns on `imap_folders`** — `headers_synced_count`, `bodies_fetched_count`, `live_window_target_count`, `historical_target_count` — updated incrementally:

- `headers_synced_count` increments in `repository.upsertMessages` when a NEW row is inserted (the `ON CONFLICT` path is a no-op for the counter).
- `bodies_fetched_count` increments in `repository.storeBody`.
- `live_window_target_count` is set in `setInitialSyncSnapshot` (size of the snapshot UID set).
- `historical_target_count` is set when the history lane records its initial snapshot for the folder (PR-8).
- On a UIDVALIDITY reset, `handleUidValidityReset` zeros the live counts and clears the target — the folder rebuilds from scratch.

The per-account roll-up is a Postgres **VIEW** (not a materialized view) that runs cheap `SUM()` aggregates across the folder rows. No refresh management. Costs one extra index-friendly scan per `GET /accounts/:id` call, which is acceptable for the request volume this surface sees.

Both per-folder and per-account values are exposed via `GET /accounts/:id`.

API surface:

```json
{
  "id": "...",
  "sync_state": "HEALTHY",
  "live_headers_complete_pct": 100,
  "priority_bodies_complete_pct": 100,
  "live_bodies_complete_pct": 87,
  "historical_headers_complete_pct": 23,
  "historical_bodies_complete_pct": 4,
  "estimated_full_sync_at": "2026-06-15T14:00:00Z",
  "folders": [
    {"path": "INBOX", "headers_pct": 100, "bodies_pct": 100, ...},
    {"path": "Archive", "headers_pct": 100, "bodies_pct": 12, ...}
  ]
}
```

`estimated_full_sync_at` is best-effort, computed from recent body-fetch rate and remaining work. It may move backward if the provider rate-limits us; document that.

### D5: `MAX_LOCK_HOLD_MS` enforcement via cooperative checkpoints

The lock budget is enforced by polling `Date.now() >= deadline` at safe boundaries between phases and between batches inside a phase. No Promise.race-style hard kill — interrupting mid-IMAP-FETCH risks leaving the connection in an undefined state.

Rules:

- `syncAccount` records `lockHeldSince = Date.now()` immediately after `withAccountLock` succeeds. It computes `deadline = lockHeldSince + config.MAX_LOCK_HOLD_MS` and threads `deadline` into each phase.

- **Hot lane:** runs folders ordered by `sync_priority` ASC, then round-robin non-priority. Two-tier deadline behavior:
  - **Between folders:** if `Date.now() >= deadline` AND the next folder is priority AND not yet started this cycle, **still process it (P0 wins)**. Otherwise break out of the loop.
  - **Inside non-priority folders:** between batches in `syncFolder`, check the deadline. Exit cleanly at the next batch boundary if hit.
  - **Inside priority folders:** **no inner deadline check** — the folder runs to current-cycle completion, bounded by `INCREMENTAL_TOTAL_TIMEOUT_MS = 5 min`. This defends P0 "never miss email" at the cost of occasionally overrunning the budget by up to 5 minutes. Documented as intentional in `reliability-invariants.md`.

- **Body lane (capped):** runs after hot. Capped at `MAX_BODY_BATCHES_PER_TICK` batches per tick (default `4`, with `BODY_BACKFILL_BATCH_SIZE = 25` → up to **100 bodies per tick**). Deadline checked between batches. Whichever ends first (cap or deadline) ends the body lane. The cap protects history's slice from being eaten by an aggressive body backlog.

  **Sizing this cap.** With `SYNC_INTERVAL_MS = 60_000`, ticks happen once per minute, so the cap is 100 bodies/min per account. At ~50KB average MIME size that's ~85 KB/sec per account during active body backfill. The architecture serializes accounts per worker (advisory locks + serial `for` loop in `syncDueAccounts`), so at any moment a single worker has exactly **one body in flight, total** — not `N × accounts` worth. The observed body rate in the test environment was 14 bodies/min, dominated by network/MIME-parse latency rather than the cap, so this default is conservative. The real constraints to watch are: (1) memory pressure when fetching a giant body — `BODY_RAW_MAX_BYTES = 25MB` worst case; (2) IMAP throttle (`IMAP_MAX_COMMANDS_PER_MINUTE = 200`) — body FETCH consumes commands; (3) the `SYNC_MAX_ACCOUNTS = 20` deployment envelope from ADR 0003. **Revisit `MAX_BODY_BATCHES_PER_TICK` if (a) you raise `SYNC_MAX_ACCOUNTS`, (b) the average body size grows substantially (e.g., a corpus of attachment-heavy mail), or (c) memory-pressure incidents appear in worker logs.**

- **History lane (remainder, sliced by `max_backfill_rate`):** runs after body. Gets whatever time and IMAP-command budget remains. `max_backfill_rate` (per D6) controls history's batch count per tick:
  - `small` = up to 1 history batch per tick
  - `normal` = up to 3 history batches per tick
  - `aggressive` = unbounded by count (only the deadline stops it)

  `max_backfill_rate` is **history-specific**. It does NOT affect body lane capacity.

- **Each phase returns `{ completed: boolean, processed: number, hitDeadline: boolean }`.** `syncAccount` reports `outcome: 'success'` with `hitLockBudget: true` on the `SyncResult` when any phase hit the deadline. Budget exhaustion is a normal completion mode, not a failure. PR-1 implemented this flag as `SyncResult.hitLockBudget` and stores it in sync-run metadata.

- **A budget-hit cycle does not reset the backoff counters.** A slow account that always hits budget could otherwise never reach "3 consecutive successes" and would never clear backoff. Treat budget-hit as neutral.

### D6: Per-account settings — five new columns on `imap_accounts`

Type-safe columns, not JSONB. SQL `CHECK` constraints document and enforce allowed enums. Defaults:

| Column | Type | Default | Allowed values |
|---|---|---|---|
| `live_window_days` | `int` | `90` | `30`, `90`, `180` |
| `historical_backfill_mode` | `text` | `'metadata_and_bodies'` | `'off'`, `'metadata_only'`, `'metadata_and_bodies'` |
| `archive_refresh_interval` | `text` | `'monthly'` | `'never'`, `'monthly'`, `'weekly'` |
| `archive_flag_sync` | `boolean` | `false` | true/false |
| `max_backfill_rate` | `text` | `'normal'` | `'small'`, `'normal'`, `'aggressive'` |

`max_backfill_rate` maps to history batches per lock acquisition:

- `small` = up to 1 history batch per tick
- `normal` = up to 3 history batches per tick
- `aggressive` = unbounded within the lock budget (uses all remaining time after hot + body)

No daily token-bucket counter. The natural rate limit is the IMAP throttle + lock budget + tick interval; provider-side throttling handles the rest. `aggressive` is honest about what it actually means.

`live_window_days` is **immutable after account creation in v0.1**. The API rejects PATCH to this field. A future migration may add change support; for now, just lock it in.

### D7: Stuck-degraded escalation — new column, retryable BROKEN

The spec's "stuck DEGRADED for 24h → BROKEN" transition is implemented around `last_priority_sync_succeeded_at` (ADR 0009).

- `markAccountSyncSucceeded` and `markAccountSyncPartial` update it to `now()` (both mean priority folders succeeded).
- `markAccountSyncFailed` and `markAccountSyncAuthFailed` leave it unchanged.
- `markAccountSyncFailed` checks current `DEGRADED` accounts, plus retryable `BROKEN` accounts with reason `STUCK_DEGRADED_24H`; if `last_priority_sync_succeeded_at < now() - interval '24 hours'`, it lands at `BROKEN` with reason `STUCK_DEGRADED_24H`.
- New config constant: `STUCK_DEGRADED_BROKEN_THRESHOLD_MS = 24 * 60 * 60_000`.

**Retryable BROKEN — composition with `getRunnableAccounts` and `backoff_until`:**

- When the SQL CASE lands on `STUCK_DEGRADED_24H`, it also writes `backoff_until = now() + interval '1 hour'`. This piggybacks on the existing `backoff_until` filter for retry cadence — **no new scheduling column needed**. `consecutive_failures` is NOT incremented further (we want hourly retries, not exponential growth).
- Extend `getRunnableAccounts`'s WHERE clause from `sync_state NOT IN ('PAUSED', 'BROKEN')` to:

  ```sql
  (
    sync_state NOT IN ('PAUSED', 'BROKEN')
    OR (sync_state = 'BROKEN' AND sync_state_reason = 'STUCK_DEGRADED_24H')
  )
  ```

  The existing `backoff_until IS NULL OR backoff_until <= now()` check handles the cadence. The existing `currently_syncing` + heartbeat check is unaffected. No changes to `next_sync_due_at` (folder-level, not account-level).
- On each retry tick: if priority succeeds, `markAccountSyncSucceeded`'s SQL CASE puts the account back to HEALTHY/DEGRADED appropriately and clears `backoff_until`. If priority fails again, the next `markAccountSyncFailed` re-evaluates the stuck-degraded condition.

**7-day terminal cutoff:**

- The SQL CASE for `STUCK_DEGRADED_24H` includes a sub-branch: if `last_priority_sync_succeeded_at < now() - interval '7 days'`, set `sync_state_reason = 'STUCK_DEGRADED_TERMINAL'` and clear `backoff_until`.
- `STUCK_DEGRADED_TERMINAL` is NOT in the retryable-BROKEN exception above, so `getRunnableAccounts` stops returning the account.
- Operator intervention required: clear `sync_state_reason` and move `sync_state` back to a non-terminal state through an admin/tooling path, restoring scheduling.
- Configurable: `STUCK_DEGRADED_TERMINAL_THRESHOLD_MS` default `7 * 24 * 60 * 60_000`.

### D8: Initial-sync stall timeout — mirrors incremental

Mechanical: `INITIAL_SYNC_BATCH_TIMEOUT_MS` is in config (default `5 * 60_000`). Initial sync snapshot SEARCH, bounded SEARCH, and ≤1 batch FETCH use the existing `withOperationDeadline` helper. On timeout: abort IMAP via `client.close()`, throw, treat as transient failure in the outer `syncFolder` catch, and do NOT advance `initial_sync_oldest_uid_synced`. Identical handling to `INCREMENTAL_TOTAL_TIMEOUT_MS`.

### D9: Folder-count cap — warn at 50, enforce at 200, track-all + degrade

Two thresholds:

- `FOLDER_COUNT_WARN_THRESHOLD = 50` — account stays HEALTHY-eligible, but `sync_state_reason` includes `MANY_FOLDERS_PERFORMANCE_NOTE`.
- `FOLDER_COUNT_ENFORCE_THRESHOLD = 200` — account becomes `DEGRADED` with reason `TOO_MANY_FOLDERS_REQUIRES_MANUAL_CONFIG`. Only INBOX and Sent are tracked. Other folders stay in the table but are not tracked or synced.

Per-account override: `folder_count_cap_override int NULL` lets operators raise the enforce threshold for known-large accounts.

New API endpoint: `POST /accounts/:id/folders/track` with `{ path: string }` explicitly opts in a single folder past the cap.

**Auto-recovery.** If the folder count drops back below the threshold on a future discovery (user pruned folders provider-side), the `sync_state_reason` clears and the account can return to HEALTHY. No manual unsticking required.

No "most recently used" heuristic. The spec's "if identifiable" hints this is hard; default to INBOX + Sent only and require explicit opt-in for the rest.

### D10: Reactive rediscovery + PENDING_VERIFICATION

The spec's reactive rediscovery is implemented as **deferred**: when a folder operation fails with a missing-mailbox error, we set `next_folder_discovery_at = now()` on the account so discovery runs next tick (≤60s away) instead of waiting up to `FOLDER_DISCOVERY_INTERVAL_MS = 15 min`.

Detection prefers ImapFlow's structured fields over regex on message text:

1. **Primary: structured response code.** ImapFlow attaches `err.serverResponseCode` to errors thrown from IMAP NO responses that carry an RFC-5530-style code (e.g., `* a NO [NONEXISTENT] Mailbox doesn't exist`). The extractor lives in `node_modules/.../imapflow/lib/tools.js`. Match against `err.serverResponseCode === 'NONEXISTENT' || err.serverResponseCode === 'TRYCREATE'`. This covers compliant servers including Gmail, Outlook, and Rackspace.
2. **Fallback: regex on `err.message`.** Only when `serverResponseCode` is absent (older or non-compliant servers). Patterns are case-insensitive: `/does not exist/`, `/no such mailbox/`, `/mailbox not found/`. The fallback exists to avoid silently swallowing real missing-mailbox conditions from a long tail of weird providers — not as the primary path.
3. **False positives are cheap** — one extra discovery cycle. Better to over-trigger than to miss the case.

Detection is centralized in a helper (`isMissingMailboxError(err)`) alongside `isAuthError` in `sync-engine.ts` for symmetry. Both helpers prefer structured codes when available.

**Related bug fix:** Today, when LIST omits a folder, it stamps `missing_since` but leaves `tracked = true` and `status != 'MISSING'` until the 7-day grace expires. `getFoldersDueForSync` keeps returning the folder, and `syncFolder` keeps hitting "mailbox doesn't exist" once per 60s tick, for 7 days. ~10,000 failing IMAP commands per orphaned folder per grace period.

Fix: add `PENDING_VERIFICATION` to the `imap_folders.status` CHECK constraint. When a missing-mailbox error fires in `syncFolder`'s catch handler, set the folder to `PENDING_VERIFICATION`. Update `getFoldersDueForSync` to also exclude `PENDING_VERIFICATION`. When the folder reappears in LIST, `upsertDiscoveredFolders` transitions `PENDING_VERIFICATION → PENDING`, which re-syncs naturally.

## Schema Changes Summary

One migration per PR (see §PR Sequence). Aggregated, the new schema state is:

**`imap_accounts`** — add:

```sql
ALTER TABLE public.imap_accounts
  ADD COLUMN last_priority_sync_succeeded_at timestamptz,
  ADD COLUMN live_window_days int NOT NULL DEFAULT 90
    CHECK (live_window_days IN (30, 90, 180)),
  ADD COLUMN historical_backfill_mode text NOT NULL DEFAULT 'metadata_and_bodies'
    CHECK (historical_backfill_mode IN ('off', 'metadata_only', 'metadata_and_bodies')),
  ADD COLUMN archive_refresh_interval text NOT NULL DEFAULT 'monthly'
    CHECK (archive_refresh_interval IN ('never', 'monthly', 'weekly')),
  ADD COLUMN archive_flag_sync boolean NOT NULL DEFAULT false,
  ADD COLUMN max_backfill_rate text NOT NULL DEFAULT 'normal'
    CHECK (max_backfill_rate IN ('small', 'normal', 'aggressive')),
  ADD COLUMN folder_count_cap_override int;
```

Extend `sync_state_reason` documentation (no CHECK, freeform) with the new reasons: `STUCK_DEGRADED_24H`, `MANY_FOLDERS_PERFORMANCE_NOTE`, `TOO_MANY_FOLDERS_REQUIRES_MANUAL_CONFIG`.

**`imap_folders`** — extend status CHECK and add incremental progress counters:

```sql
-- D10: PENDING_VERIFICATION state
ALTER TABLE public.imap_folders DROP CONSTRAINT imap_folders_status_check;
ALTER TABLE public.imap_folders ADD CONSTRAINT imap_folders_status_check
  CHECK (status IN ('PENDING', 'SYNCING', 'ACTIVE', 'NEEDS_FULL_RESYNC', 'MISSING', 'PENDING_VERIFICATION'));

-- D4: incremental progress counters
ALTER TABLE public.imap_folders
  ADD COLUMN headers_synced_count int NOT NULL DEFAULT 0,
  ADD COLUMN bodies_fetched_count int NOT NULL DEFAULT 0,
  ADD COLUMN live_window_target_count int,
  ADD COLUMN historical_target_count int;
```

Counter update sites (all incremental, no full table scans):
- `upsertMessages` → `headers_synced_count += <new row count>` (only when `ON CONFLICT` did NOT fire).
- `storeBody` → `bodies_fetched_count += 1`.
- `setInitialSyncSnapshot` → `live_window_target_count = <snapshot size>`.
- History lane snapshot (PR-8) → `historical_target_count = <snapshot size>`.
- `handleUidValidityReset` → zero `headers_synced_count`, `bodies_fetched_count`, and clear `live_window_target_count`.

**New view `imap_account_progress`** — per-account roll-up:

```sql
CREATE VIEW public.imap_account_progress AS
SELECT
  a.id AS account_id,
  -- counts and percentages computed from imap_folders and imap_messages joins
  ...
FROM public.imap_accounts a;
```

Computed columns: `live_headers_complete_pct`, `priority_bodies_complete_pct`, `live_bodies_complete_pct`, `historical_headers_complete_pct`, `historical_bodies_complete_pct`, `estimated_full_sync_at`.

## Code Changes Summary

By module, what changes:

- **`apps/api/src/config.ts`** — add `FOLDER_COUNT_WARN_THRESHOLD` (50), `FOLDER_COUNT_ENFORCE_THRESHOLD` (200). `INITIAL_SYNC_BATCH_TIMEOUT_MS`, `MAX_BODY_BATCHES_PER_TICK`, `MAX_LOCK_HOLD_MS`, and the stuck-degraded thresholds are now wired (see D5, D7, and D8).
- **`apps/api/src/sync-engine.ts`** — thread `deadline` into hot/body/history phases with the two-tier semantics from D5. Add `isMissingMailboxError(err)` helper alongside `isAuthError`, preferring `err.serverResponseCode` over message regex. Wrap `runInitialSyncBatch` in `withOperationDeadline` (D8). Add missing-mailbox detection in `syncFolder`'s catch (D10). Add the history lane as a new method called after `fetchBodyBacklog`, sliced by `max_backfill_rate`. Thread `hitLockBudget` flag through `SyncResult`. `fetchBodyBacklog` becomes deadline-aware and capped at `MAX_BODY_BATCHES_PER_TICK`.
- **`apps/api/src/repository.ts`** — update `markAccountSyncSucceeded`/`Partial` to write `last_priority_sync_succeeded_at`; update `markAccountSyncFailed` to add the `STUCK_DEGRADED_24H` / `STUCK_DEGRADED_TERMINAL` branches, including the `backoff_until = now() + interval '1 hour'` write on retryable escalation. Update `getRunnableAccounts`'s WHERE clause to allow `BROKEN` accounts whose reason is `STUCK_DEGRADED_24H` (composing with the existing `backoff_until` filter). Update `upsertMessages` to increment `headers_synced_count` only on new inserts (D4). Update `storeBody` to increment `bodies_fetched_count` (D4). Update `setInitialSyncSnapshot` to record `live_window_target_count` (D4). Update `handleUidValidityReset` to zero per-folder counters (D4). Update `upsertDiscoveredFolders` for folder-count cap thresholds (D9). Add `markFolderPendingVerification` (D10). Add `getHistoryBacklog` and `advanceBackfillWatermark` for the history lane. Add `runArchiveRefresh` (cheap reconcile-like pass on historical folders per `archive_refresh_interval`).
- **`apps/api/src/api.ts`** — extend `GET /accounts/:id` to return the progress columns. Add `POST /accounts/:id/folders/track`. Add `PATCH /accounts/:id/settings` for the new tunables (rejecting `live_window_days`).
- **`apps/api/src/types.ts`** — extend `ImapAccount`, `ImapFolder`, `SyncResult` with the new fields.
- **`apps/api/scripts/spec-conformance.ts`** — add scenarios G-M (see §Test Plan).

## Doc Changes Summary

- **`docs/agent/reliability-invariants.md`** — add a "Lane Discipline" section, a "Lock Budget" section, a "PENDING_VERIFICATION semantics" line, a "Settings Immutability" line, and update the scope section with "Search is downstream."
- **`docs/spec-conformance.md`** — promote the three currently-open drifts (lock hold, initial-sync stall, stuck-degraded) from open deltas to Implemented rows once the corresponding PRs land. Update the matrix to reflect the four reliability fixes.
- **`docs/schema.md`** — document the new `imap_accounts` columns, the extended `imap_folders.status` CHECK, and the new `imap_account_progress` view.
- **`docs/architecture/decisions/`** — promote each of D5, D7, D8, D9, D10 to an ADR when the corresponding PR lands. Specifically:
  - ADR 0008: Cooperative lock budget enforcement
  - ADR 0009: Last-priority-success column for stuck-degraded escalation (landed)
  - ADR 0010: Folder-count cap with track-all-degrade
  - ADR 0011: PENDING_VERIFICATION state for missing-mailbox recovery
  - ADR 0012: Three-lane engine architecture (lands with PR-8)
- **`README.md`** — update the "What You Get" section to mention progress columns. Update the body-fetch policy section to mention historical backfill.
- **`docs/agent/feature-list.json`** — `issue-2-historical-backfill` becomes `blocked_by` PRs 1-7.

## Test Plan

Each new code PR carries a `scripts/spec-conformance.ts` scenario that proves the change. The live-DB suite (`pnpm test:db:live`) is the gate.

New scenarios:

- **G — Lock budget honored, with priority vs non-priority mid-FETCH semantics.**
  - **G.1 Priority folder gets its turn even when deadline already exceeded.** Set up a fixture with a priority folder + several non-priority folders. Construct a clientFactory that delays `getMailboxLock` so the first folder's processing pushes the elapsed time past `MAX_LOCK_HOLD_MS` before the next folder is considered. Assert: the priority folder is still processed (the between-folder check exempts it as P0), non-priority folders are skipped, `hitLockBudget = true`, `bodiesFetched = 0`, history skipped, lock released.
  - **G.2 Non-priority folder exits cleanly at batch boundary.** Set up a fixture with a non-priority folder containing many messages and a small `INCREMENTAL_SYNC_BATCH_SIZE`. Use a clientFactory whose per-batch FETCH delay pushes elapsed time past the deadline mid-folder. Assert: persisted state reflects batches that completed before the deadline; no batch was partially applied; no error in `result.errors`; `hitLockBudget = true`.
  - **G.3 Backoff counters not reset on a budget-hit success cycle.** With G.1 or G.2's setup, sanity-check `consecutive_successes` did NOT increment to ≥ 3 (which would otherwise zero `current_backoff_ms`). Budget-hit is neutral.
  - **G.4 Lock released.** Independent assertion across G.1–G.3: `pg_locks` shows no advisory lock on the account's `lock_id` after `syncAccount` returns.
- **H — Initial sync stall timeout.** Fixture FETCH hangs past `INITIAL_SYNC_BATCH_TIMEOUT_MS`; assert deadline fires, IMAP is aborted, watermark is not advanced, account is marked transient-failed, and the next cycle resumes from the same watermark.
- **I — Stuck-degraded escalation, retry composition, and 7-day terminal cutoff.**
  - **I.1 Escalation to retryable BROKEN.** Seed an account at `sync_state = DEGRADED` with `last_priority_sync_succeeded_at` backdated 25h. Trigger a sync that fails (e.g., clientFactory throws non-auth error). Assert: `sync_state = 'BROKEN'`, `sync_state_reason = 'STUCK_DEGRADED_24H'`, `backoff_until` is approximately `now() + 1 hour`, `consecutive_failures` did NOT bump exponentially (i.e., backoff stayed at the hourly cadence, not doubling).
  - **I.2 `getRunnableAccounts` returns it once `backoff_until` elapses.** With I.1's state, manually backdate `backoff_until` to `now() - 1 second`. Call `repository.getRunnableAccounts(10)`. Assert: the account is in the returned list.
  - **I.3 Recovery on successful priority sync.** With the account in I.2's retryable-BROKEN state, supply a clientFactory that returns a working IMAP fixture. Run `syncAccount`. Assert: `sync_state = 'HEALTHY'` (or `INITIAL_SYNC` if folders are still incomplete), `last_priority_sync_succeeded_at` updated to ~now, `sync_state_reason` cleared, `backoff_until` cleared.
  - **I.4 Terminal cutoff at 7 days.** Seed an account with `last_priority_sync_succeeded_at` backdated 8 days and `sync_state = 'BROKEN'`, `sync_state_reason = 'STUCK_DEGRADED_24H'`. Backdate `backoff_until` so the account is retried. Supply a failing clientFactory. Trigger sync. Assert: `sync_state_reason = 'STUCK_DEGRADED_TERMINAL'`, `backoff_until` cleared (no further retries scheduled), `getRunnableAccounts` no longer returns the account.
  - **I.5 Manual operator clear restores scheduling.** With I.4's terminal state, manually `UPDATE imap_accounts SET sync_state = 'DEGRADED', sync_state_reason = NULL WHERE id = ?`. Assert: `getRunnableAccounts` returns the account again. (Documents the operator escape hatch.)
- **J — Folder-count cap (warn + enforce).** Fixture with 60 folders → DEGRADED with `MANY_FOLDERS_PERFORMANCE_NOTE`, all 60 tracked. Fixture with 250 folders → DEGRADED with `TOO_MANY_FOLDERS_REQUIRES_MANUAL_CONFIG`, only INBOX/Sent tracked. Drop to 45 folders → recovers to HEALTHY-eligible.
- **K — PENDING_VERIFICATION fix.** Fixture missing-mailbox error → folder transitions to PENDING_VERIFICATION, `next_folder_discovery_at` set to now, `getFoldersDueForSync` skips it on the next call. Then re-LIST it → folder back to PENDING then ACTIVE on the cycle after.
- **L — Three-lane priority ordering.** Backlog of body fetches + history work; assert hot folders sync first, body backlog drains second, history runs third, history is skipped when body budget exhausted.
- **M — Progress columns roll up.** Mirror a fixture with partial body completion across folders; assert per-folder counters in `imap_folders` and per-account percentages in `imap_account_progress` view match expected.

Existing scenarios A-F continue to gate.

## PR Sequence

Each PR carries its own migration (if any), code, scenario, and doc update. Each is independently revertible.

1. **PR-1: `MAX_LOCK_HOLD_MS` enforcement.** Cooperative checkpoints, soft-exempt for priority folders mid-FETCH, `hitLockBudget` flag on `SyncResult`, backoff counters not reset on budget-hit. Scenario G. Updates `reliability-invariants.md` with the lock-budget invariant. Promotes D5 to ADR 0008. **No migration.**
2. **PR-2: Initial-sync stall timeout.** Add `INITIAL_SYNC_BATCH_TIMEOUT_MS`, wrap `runInitialSyncBatch`. Scenario H. Updates `reliability-invariants.md`. **No migration.**
3. **PR-3: Stuck-degraded escalation.** Migration: add `last_priority_sync_succeeded_at` column. Wire it in `markAccountSync*`, add the `STUCK_DEGRADED_24H` branch, update `getRunnableAccounts` for retryable BROKEN. Scenario I. Promotes D7 to ADR 0009.
4. **PR-4: Folder-count cap + PENDING_VERIFICATION state.** Migration: extend `imap_folders.status` CHECK to include `PENDING_VERIFICATION`, add `folder_count_cap_override` column to `imap_accounts`. Wire warn/enforce thresholds. Scenario J. Promotes D9, D10 (partial) to ADRs 0010, 0011.
5. **PR-5: Reactive rediscovery.** Builds on PR-4. Missing-mailbox detection in `syncFolder`'s catch, set `next_folder_discovery_at = now()` and `status = PENDING_VERIFICATION`. New API endpoint `POST /accounts/:id/folders/track`. Scenario K. Completes ADR 0011.
6. **PR-6: Per-account settings columns + defaults.** Migration: 5 new columns on `imap_accounts` with `CHECK` constraints. API `PATCH /accounts/:id/settings`. No engine behavior change yet — the columns exist, defaults apply, but the engine doesn't consume them. Sets up PR-8.
7. **PR-7: Progress columns + per-account roll-up view.** Migration: new `imap_account_progress` view. Extend `GET /accounts/:id` to return progress fields. Scenario M.
8. **PR-8: Three-lane engine — history lane wiring.** Depends on PR-1 (budget), PR-6 (settings), PR-7 (progress). Adds `getHistoryBacklog`, history lane in `MirrorEngine.syncAccount`, archive refresh pass. Engine consumes `historical_backfill_mode`, `archive_refresh_interval`, `max_backfill_rate`. Scenario L. Promotes D2 to ADR 0012. This IS the historical-backfill feature (closes `issue-2-historical-backfill`).

PRs 1–5 are the boring reliability hardening — the original four spec fixes plus the loop bug. They can land in any order among themselves (no inter-PR dependencies except PR-5 needs PR-4's `PENDING_VERIFICATION` state).

PRs 6–8 are the historical backfill feature build. They land in order after the reliability gate is solid.

## Open Questions / Explicit Deferrals

Things this plan does NOT solve. Each becomes a candidate for a follow-on issue.

- **`live_window_days` change after onboarding.** Locked to creation-time in v0.1. A migration story (re-classifying `window_status` for newly in-window or newly out-of-window messages, handling the historical lane's relationship to the moving boundary) is deferred to v0.2.
- **`estimated_full_sync_at` accuracy.** Best-effort. Documented as approximate. We do not commit to a tight bound. May move backward when the provider rate-limits.
- **Counter drift correction.** D4's incremental counters can drift if a bug causes them to skip an update, double-count, or if a transaction is partially applied. Source of truth recovery is a `SELECT count(*) FROM imap_messages WHERE folder_id = ?` resync — accurate but O(messages) per folder. v0.1 ships without an automatic drift detector; if drift is observed in production we add a periodic resync job. Each counter update is inside the same transaction as the underlying insert/update, so the common bug modes (mid-tx crash, partial batch) preserve consistency.

- **Per-folder body-fetch priority overrides.** v0.1 uses `sync_priority` (folder-level) for body lane ordering. A future "this folder's bodies are critical, fetch first" override could be a per-folder JSONB column. Not in scope.
- **On-demand body refresh for a single folder/slice.** The user mentioned "if user searches/opens an old folder/message, we can refresh that slice on demand" — this is a separate API endpoint outside the engine's scheduling. Not in scope for v0.1.
- **IMAP IDLE for sub-tick freshness.** The current 60-second poll is the floor. IMAP IDLE would push notifications and reduce latency to <1s, but it's a significant connection-lifecycle change. Tracked separately.
- **Per-provider body-fetch rate tuning.** `IMAP_MAX_COMMANDS_PER_MINUTE` is currently global. Provider profiles could carry their own throttle. Not in scope.
- **Search indexing within SupaMail.** Out of scope by D3 — search lives downstream. Don't merge a PR that adds tsvector/GIN/full-text indexing without re-opening D3.

## References

- `docs/spec-conformance.md` — current conformance state and open deltas
- `docs/agent/reliability-invariants.md` — agent-facing reliability contract
- `.context/old-spec-used-to-build-original-signal-sync-engine.md` — original Rackspace/Signal sync spec this work imports from
- `apps/api/src/sync-engine.ts` — current engine to extend
- `apps/api/src/repository.ts` — persistence layer to extend
- `apps/api/src/locks.ts` — advisory lock and orphan recovery
- `apps/api/scripts/spec-conformance.ts` — live conformance gate to extend with G-M
- `docs/agent/feature-list.json` — `issue-2-historical-backfill` becomes blocked by PRs 1-7
- `docs/architecture/decisions/` — ADRs 0008-0012 will be promoted from this plan as PRs land
