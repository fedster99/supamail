# ADR 0010: Enforce Folder-Count Caps With Priority-Only Tracking

Status: Accepted

Date: 2026-05-24

## Context

Large IMAP accounts can expose hundreds of folders. Syncing every folder by default turns normal scheduling into a folder-explosion problem and can hide fresh priority mail behind low-value archive work.

Provider profiles already exclude dangerous folders such as Spam, Trash, and All Mail. That is not enough for accounts with many legitimate archive-like folders.

## Decision

Add two configurable folder-count thresholds:

- `FOLDER_COUNT_WARN_THRESHOLD` records `MANY_FOLDERS_PERFORMANCE_NOTE` while keeping the account healthy-eligible.
- `FOLDER_COUNT_ENFORCE_THRESHOLD` records `TOO_MANY_FOLDERS_REQUIRES_MANUAL_CONFIG`, makes the account `DEGRADED` once other higher-priority health checks are clean, and tracks only priority folders such as INBOX and Sent.

Non-priority folders over the enforce threshold stay in `imap_folders` with `excluded_reason = 'folder_count_cap_exceeded'`. They are not scheduled or body-backfilled while excluded.

`imap_accounts.folder_count_cap_override` lets operators raise the enforce threshold for known-large accounts. The current provider folder count is based on the latest successful LIST (`missing_since IS NULL`), so the account automatically recovers if the provider folder count drops below the thresholds on a later discovery.

## Consequences

- Large accounts remain visible and operator-actionable instead of silently slowing the whole sync loop.
- Priority mail continues syncing even when an account has too many folders.
- Warning-level folder counts can still become `HEALTHY`; the note is advisory.
- Recovery does not require manual state clearing when the provider-side folder count is reduced.

## Verification

- `apps/api/src/__tests__/sync-engine.integration.test.ts` Scenario J proves warn, enforce, priority-only tracking, and automatic recovery.
- `apps/api/scripts/spec-conformance.ts` Scenario J proves the same behavior against real Postgres.
- `pnpm test:db:live` runs migration idempotence, live integration, and spec conformance.

## References

- `apps/api/src/repository.ts`
- `apps/api/supabase/migrations/public/0003_folder_count_cap_pending_verification.sql`
- `docs/architecture/reliability-and-three-lanes.md` D9
