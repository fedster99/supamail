# Schema Overview

The mirror owns these neutral tables in `public`:

- `imap_accounts`
- `imap_folders`
- `imap_messages`
- `imap_message_bodies`
- `imap_attachments`
- `imap_sync_runs`
- `imap_sync_events`
- `imap_account_progress` (view)

RLS is enabled on all mirror tables and `anon`/`authenticated` access is revoked when those Supabase roles exist. `imap_account_progress` is a `security_invoker` view and also revokes `anon`/`authenticated` access when those roles exist. The worker/API should use a direct Postgres connection string, not the browser-facing Supabase Data API.

`imap_messages` stays metadata-oriented so list queries remain small. Full body data lives in `imap_message_bodies`.

`imap_message_bodies.raw_mime` stores RFC822/MIME bytes. Parsed fields store plain text, HTML, normalized text, parsed headers, selected text part, parser warnings, and MIME structure snapshots. With `BODY_STORAGE_MODE=parsed_only`, bodies are still fetched and parsed but `raw_mime` is stored as NULL; `raw_bytes` and `raw_truncated` keep describing the fetched source.

Messages are soft-deleted when reconciliation, folder disappearance, UIDVALIDITY resets, or provider deletion indicate they are no longer visible.

`imap_accounts.last_priority_sync_succeeded_at` records the last sync cycle where priority folders succeeded. It powers stuck-degraded escalation: after the configured 24h threshold, a degraded account becomes retryable `BROKEN` with reason `STUCK_DEGRADED_24H`; after the terminal threshold, it becomes `STUCK_DEGRADED_TERMINAL`.

`imap_accounts.folder_count_cap_override` lets operators raise the folder-count enforce threshold for known-large accounts. Without an override, `FOLDER_COUNT_WARN_THRESHOLD` records `MANY_FOLDERS_PERFORMANCE_NOTE`, and `FOLDER_COUNT_ENFORCE_THRESHOLD` records `TOO_MANY_FOLDERS_REQUIRES_MANUAL_CONFIG` while tracking only priority folders such as INBOX and Sent.

`POST /accounts/:id/folders/track` lets operators opt an existing non-provider-excluded folder back into sync past the folder-count cap. The opt-in is persisted on the folder so the next discovery pass does not reapply `folder_count_cap_exceeded` to that path.

`imap_accounts` also stores the account-level lane settings consumed by the history lane: `live_window_days`, `historical_backfill_mode`, `archive_refresh_interval`, `archive_flag_sync`, and `max_backfill_rate`. The columns are type-safe Postgres fields with CHECK constraints and defaults. In v0.1, `live_window_days` is immutable after account creation; `PATCH /accounts/:id/settings` rejects attempts to change it and only updates the mutable historical/archive/backfill-rate settings.

`imap_folders` stores incremental progress counters: `headers_synced_count`, `bodies_fetched_count`, `live_window_target_count`, and `historical_target_count`. Header counters advance when new mailbox rows are inserted, body counters advance only on the first successful body fetch for a message, and UIDVALIDITY resets clear the live and historical progress for that folder.

Historical backfill uses the folder-level `backfill_in_progress`, `backfill_target_max_uid`, `backfill_oldest_uid_synced`, `backfill_since_date`, and `last_archive_refresh_at` fields. The history lane snapshots UIDs older than the live window, walks them newest-first in resumable batches, stores metadata as `window_status = 'HISTORICAL'`, and fetches historical bodies when `historical_backfill_mode = 'metadata_and_bodies'`.

`imap_account_progress` rolls those folder counters up into account-level percentages for `GET /accounts/:id`: live headers, priority bodies, live bodies, historical headers, historical bodies, and a nullable `estimated_full_sync_at`. The estimate is currently null until a durable rate model exists.

`imap_folders.status` includes `PENDING_VERIFICATION` for folders that need a missing-mailbox verification pass. Missing-mailbox errors stamp `missing_since`, force `imap_accounts.next_folder_discovery_at = now()`, and move the folder into `PENDING_VERIFICATION`. The scheduler excludes that state from normal sync work, and folder discovery moves a reappeared folder back to `PENDING`.

`0008_search_layer` adds the deterministic, pure-Postgres search layer (see ADR 0015). It adds two STORED generated `tsvector` columns — `imap_messages.header_fts` (weight A subject, B sender, C recipients) and `imap_message_bodies.body_fts` (weight D, the HTML-stripped `body_text`, capped at 128 KB) — so the searchable document materializes incrementally with no trigger or queue and no staleness when the body arrives late. It adds a `btree_gin` account-scoped FTS GIN on `(account_id, header_fts)`, a body FTS GIN, `pg_trgm` GINs on lowercased subject/sender/recipients/filename for substring and identifier matching, a `flags` GIN, and structured b-trees for size, folder, sender, sender-domain, unread, and thread. All message indexes are partial on `deleted_in_provider = false`; search always drives off `imap_messages` (the authoritative account- and soft-delete-scoped side) with `body_fts` used JOIN-only, so soft-deleted bodies never leak. There are deliberately no raw `to_emails`/`cc_emails` array GINs — emails are stored verbatim, so recipient matching is lowercased. A self-gated Tier-2 block creates an opt-in `imap_message_embeddings` table plus an HNSW index only when the `vector` extension is already installed; the pure core never requires pgvector. The read path lives in `apps/api/src/search/` (`searchMessages`), wrapped by the `supamail search` CLI command and the `search_email` MCP tool contract.

`0013_body_head_trigram_index` adds exact substring support over the same bounded 128 KB body head. Consumers must use `left(coalesce(body_text, body_plain, selected_text_part, ''), 131072)` verbatim so PostgreSQL can select the expression GIN; natural-language lexical search continues to use `body_fts`.

## Migration Boundaries

Public mirror migrations live under `apps/api/supabase/migrations/public/` and are the only migrations that `pnpm migrate`, the CLI, and the API `/migrate` endpoint apply. The manifest in that directory records the ordered public migration ids and required public schema version for hosted deploy gates.

Hosted control-plane migrations for users, tenants, billing, Stripe events, Supabase OAuth tokens, provisioning jobs, or entitlements must live outside this public core repository, in the private hosted-product repo. Customer BYO Supabase databases must receive only the public mirror migrations.
