# Schema Overview

The mirror owns these neutral tables in `public`:

- `imap_accounts`
- `imap_folders`
- `imap_messages`
- `imap_message_bodies`
- `imap_attachments`
- `imap_sync_runs`
- `imap_sync_events`

RLS is enabled on all mirror tables and `anon`/`authenticated` access is revoked when those Supabase roles exist. The worker/API should use a direct Postgres connection string, not the browser-facing Supabase Data API.

`imap_messages` stays metadata-oriented so list queries remain small. Full body data lives in `imap_message_bodies`.

`imap_message_bodies.raw_mime` stores RFC822/MIME bytes. Parsed fields store plain text, HTML, normalized text, parsed headers, selected text part, parser warnings, and MIME structure snapshots.

Messages are soft-deleted when reconciliation, folder disappearance, UIDVALIDITY resets, or provider deletion indicate they are no longer visible.

`imap_accounts.last_priority_sync_succeeded_at` records the last sync cycle where priority folders succeeded. It powers stuck-degraded escalation: after the configured 24h threshold, a degraded account becomes retryable `BROKEN` with reason `STUCK_DEGRADED_24H`; after the terminal threshold, it becomes `STUCK_DEGRADED_TERMINAL`.

`imap_accounts.folder_count_cap_override` lets operators raise the folder-count enforce threshold for known-large accounts. Without an override, `FOLDER_COUNT_WARN_THRESHOLD` records `MANY_FOLDERS_PERFORMANCE_NOTE`, and `FOLDER_COUNT_ENFORCE_THRESHOLD` records `TOO_MANY_FOLDERS_REQUIRES_MANUAL_CONFIG` while tracking only priority folders such as INBOX and Sent.

`imap_folders.status` includes `PENDING_VERIFICATION` for folders that need a future missing-mailbox verification pass. The scheduler excludes that state from normal sync work, and folder discovery moves a reappeared folder back to `PENDING`.

## Migration Boundaries

Public mirror migrations live under `apps/api/supabase/migrations/public/` and are the only migrations that `pnpm migrate`, the CLI, and the API `/migrate` endpoint apply. The manifest in that directory records the ordered public migration ids and required public schema version for hosted deploy gates.

Hosted control-plane migrations for users, tenants, billing, Stripe events, Supabase OAuth tokens, provisioning jobs, or entitlements must live outside this public core repository, in the private hosted-product repo. Customer BYO Supabase databases must receive only the public mirror migrations.
