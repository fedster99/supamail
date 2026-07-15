# Schema Overview

The mirror owns these neutral tables in `public`:

- `imap_accounts`
- `imap_folders`
- `imap_messages`
- `imap_message_bodies`
- `imap_attachments`
- `imap_message_evidence`
- `imap_sync_runs`
- `imap_sync_events`
- `imap_thread_runs`
- `imap_thread_state`
- `imap_thread_evidence_clock`
- `imap_thread_assignments`
- `imap_thread_work_queue`
- `imap_thread_subject_work`
- `imap_thread_operations`
- `imap_thread_run_comparisons`
- `imap_thread_assignment_history`
- `imap_account_progress` (view)
- `imap_thread_active_assignments` (view)

RLS is enabled on all mirror tables and `anon`/`authenticated` access is revoked when those Supabase roles exist. `imap_account_progress` and `imap_thread_active_assignments` are `security_invoker` views and also revoke public/browser-role access. The worker/API should use a direct Postgres connection string, not the browser-facing Supabase Data API.

`imap_messages` stays metadata-oriented so list queries remain small. Full body data lives in `imap_message_bodies`.

`imap_message_bodies.raw_mime` stores RFC822/MIME bytes. Parsed fields store plain text, HTML, normalized text, parsed headers, selected text part, parser warnings, and MIME structure snapshots. With `BODY_STORAGE_MODE=parsed_only`, bodies are still fetched and parsed but `raw_mime` is stored as NULL; `raw_bytes` and `raw_truncated` keep describing the fetched source.

`0017_threading_body_backfill_index` keeps the legacy delivery-fingerprint repair lane bounded after most rows have been repaired. Its partial `message_id` index contains only complete bodies still missing a usable raw-MIME or parsed-delivery digest; successful repairs leave the index automatically, so later worker passes do not walk the full body table to find a sparse backlog.

`0018_threading_body_fallback_index` narrows that repair lane to rows without an exact raw-MIME digest. Parsed delivery fingerprints are fallback evidence only; deriving them when exact raw evidence already exists cannot change delivery identity. The worker hashes at most two legacy bodies per statement, then updates those primary keys in a separate statement under a 15-second transaction-local deadline so a TOAST-heavy repair cannot monopolize the projection lane.

`0016_message_evidence` adds bounded structured evidence captured while decoded MIME is available (ADR 0025). `imap_message_evidence` records decoded attachment SHA-256 identities, iCalendar instances keyed by `UID` plus `RECURRENCE-ID`, and strict provider-scoped GitHub/Google Drive/Jira/DocuSign resource identities. Each row retains an explainable bounded key, fixed-size join digest, metadata, extractor, and extractor version; it stores no attachment bytes or arbitrary URLs. `imap_message_bodies.structured_evidence_*` records the deterministic evidence digest, extractor version, completion, and attempt time. Missing-version rows re-enter the existing bounded body lanes; truncated attempts are marked incomplete and do not loop forever. These records are neutral source evidence, never conversation or work-item assignments.

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

`0014_conversation_threading` adds the durable conversation projection (ADR 0024). It preserves three separate identities:

- `imap_messages` remains one physical mailbox row, unique by account, folder, UIDVALIDITY, and UID.
- `imap_thread_assignments.delivery_key` groups verified physical copies of one delivered email.
- `imap_thread_assignments.conversation_id` groups deliveries connected by the reply graph.

`imap_messages.provider_message_id` and `provider_message_id_namespace` preserve a provider's delivery identity; `provider_thread_id_namespace` records the provenance of the existing provider conversation hint. `imap_message_bodies.raw_mime_sha256` stores a digest only for a complete, non-truncated MIME fetch. `0015_threading_production_hardening` adds `parsed_delivery_sha256`, a bounded-worker-derived digest over the exact parsed body, MIME structure, parsed headers, envelope, sizes, and parser warnings for historical `parsed_only` rows. These inputs corroborate true copies without trusting Message-ID alone.

`imap_thread_runs` is an isolated algorithm snapshot for one account. Its mode is initial, upgrade, or explicit rebuild; its bounded stages are body evidence, strong protocol graph, weak subject buckets, catch-up, and ready. `0015` moves shadow pagination to the immutable `cursor_message_id`; runs created by 0014 safely restart their current scan once after upgrade. Catch-up repairs missing assignment coverage in bounded batches before `ready`. Each run records the mirror evidence revision it has fully consumed. `imap_thread_state` points to at most one active reader run, one rollback standby, and one building/ready shadow; its `scheduler_cursor` persists the three-active/one-standby/one-building weighted schedule across workers and deploys. `imap_thread_evidence_clock` is a monotonic account clock advanced by database triggers for relevant message/body writes. `imap_thread_active_assignments` is the security-invoker/status-checked view used by readers, so cutover is one atomic pointer update rather than an in-place table rewrite.

There is one `imap_thread_assignments` row per physical message row per run. It records the strict Message-ID, fixed-size delivery/conversation evidence keys, raw root/parent/reference evidence, provider hint, normalized subject, assignment method, coarse confidence tier, provisional flag, evidence, input hash, generation, and algorithm version. Raw evidence is inspectable but unindexed; indexed adversarial header/provider values are SHA-256 digests. The RFC/provider inputs in `imap_messages` and `imap_message_bodies` remain authoritative.

`imap_thread_work_queue` receives new rows and changes to thread-relevant metadata, recovered full-body headers, or copy fingerprints independently for every state-referenced run. Repository writes enqueue explicitly, while a database trigger provides the rolling-deploy backstop. The worker drains ready items in bounded account-scoped batches and expands only the affected RFC/provider/prior-conversation closure, with independent row, evidence-byte, and criteria-key limits. `imap_thread_subject_work` evaluates one exact subject digest at a time; buckets above the configured cap are recorded and skipped only after any older weak merge in that bucket has been dissolved.

`imap_thread_operations` records bounded build batches, incremental recomputes, activation, rollback, and failures. `imap_thread_run_comparisons` stores quality thresholds and merge/split/provisional metrics for exact baseline/candidate generations at one evidence revision; replacing an active run requires a still-current passing certificate. `imap_thread_assignment_history` stores per-message before/after snapshots for incremental material changes and intentionally has no message/run foreign key, so audit evidence survives retention. Build snapshots retain compact operation summaries rather than duplicating every assignment as JSON. Incremental rollback may reverse only the latest material operation in the active run. Activation rollback swaps back only to a still-caught-up standby. Both paths record a new operation and pause automatic work pending a clean rebuild. Old terminal projection runs are pruned daily in bounded batches without deleting these audit tables.

Migration 0014 performs no mailbox-wide DML and builds no index on the existing message/body tables. New evidence columns are nullable; new checks on populated tables are `NOT VALID` while still enforcing new writes. The bounded worker backfills complete MIME hashes and assignments after deployment.

## Migration Boundaries

Public mirror migrations live under `apps/api/supabase/migrations/public/` and are the only migrations that `pnpm migrate`, the CLI, and the API `/migrate` endpoint apply. The manifest in that directory records the ordered public migration ids and required public schema version for hosted deploy gates.

Hosted control-plane migrations for users, tenants, billing, Stripe events, Supabase OAuth tokens, provisioning jobs, or entitlements must live outside this public core repository, in the private hosted-product repo. Customer BYO Supabase databases must receive only the public mirror migrations.
