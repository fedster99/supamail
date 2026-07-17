# Reliability Invariants

This is the agent-readable reliability contract distilled from `docs/spec-conformance.md`, the code, and public architecture decisions. Use it before touching sync, repository, schema, lock, health, or migration behavior.

## Identity And Storage

- Message identity is scoped by `(account_id, folder_path, uidvalidity, uid)`.
- This is physical mailbox-row identity. Do not conflate it with a delivered email or a protocol conversation.
- An assignment belongs to an account, physical message, and algorithm run. Readers must use `imap_thread_active_assignments`, never choose an arbitrary assignment row.
- `delivery_key` is the derived delivery-copy identity; `conversation_id` is the derived transitive reply-component identity. Both are account-scoped.
- Do not add CRM identity hydration, person/company resolution, handle mapping, activity construction, semantic work-item clustering, or an epistemic layer to SupaMail core.
- Never treat IMAP UID as globally unique.
- Store raw and normalized Message-ID separately.
- Preserve provider message/thread ID namespaces; provider IDs are opaque and not globally unique.
- A complete, non-truncated raw MIME fetch may store `raw_mime_sha256` as copy evidence. In `parsed_only` history, `parsed_delivery_sha256` may corroborate a copy only when the exact parsed body, MIME structure, parsed headers, envelope, sizes, and parser warnings agree. `authored_delivery_sha256` may ignore transport-added trace/authentication headers and wire sizes only when the strict Message-ID, original Date, envelope, stable MIME headers, all parsed body variants, MIME structure, parser warnings, and complete structured/attachment evidence agree. Preserve every available token; a reused Message-ID with no shared token must remain split. Derive the authored token only after different delivery candidates with the same strict Message-ID are observed, under the bounded body-evidence deadline. Never hash a truncated or materially incomplete body as if it proved delivery equality.
- Decoded attachment SHA-256, iCalendar instance IDs, and strict provider resource IDs are neutral `imap_message_evidence`, not delivery or conversation assignments. Evidence is bounded/versioned, truncated extraction is incomplete, and semantic work-item clustering remains downstream of SupaMail.
- Full MIME/body data belongs in `imap_message_bodies`; message list rows stay metadata-oriented.
- Attachment metadata is stored during sync; binary attachment fetching is not part of the current core path.
- Body backlog draining is capped per tick so recent-body work cannot consume the whole lock window forever.
- Progress counters live on `imap_folders` and must be updated in the same write path as the underlying header/body state they summarize.

## Conversation Threading

- Thread assignments are a replaceable, deterministic projection. Never overwrite source headers or provider identity to force a desired conversation.
- Parse only syntactically valid bracketed RFC Message-ID tokens for conversation truth. Compare canonical tokens case-sensitively; do not use the legacy lowercased `message_id_normalized` as the graph key.
- Prefer valid `References`. Use the first valid `In-Reply-To` only when `References` has no usable ID. Ignore malformed tokens and conflicting weaker evidence rather than guessing.
- A referenced but unmirrored Message-ID is a real provisional graph node. Preserve it so siblings group and a parent arriving later resolves the same component.
- Ambiguous/reused Message-ID owners must never select an arbitrary parent. Prefer a false split over a false merge.
- Algorithm v3 may use exact date/size/subject/from/all-recipient metadata only to join same-Message-ID candidates in distinct mailbox folders. A repeated candidate in one folder or conflicting authored digests vetoes that fallback. Raw/parsed digest disagreement is not negative evidence because transport and storage representations can differ; an eligible metadata match requests authored corroboration and remains recomputable. Treat this as mirror recovery, never as a general similarity rule.
- A directly prefixed forward is a new authored protocol conversation even when inherited `References`, `In-Reply-To`, or provider-thread evidence points at the original. Replies to the forward may attach to the forward; work-item clustering is the layer that may relate both conversations.
- Provider thread IDs are namespaced, account-scoped membership hints. They may connect a component but never create a parent edge.
- Subject fallback is last and narrow: only an otherwise standalone, human `Re:`; never a forward; exact normalized base subject; exact reciprocal sender/recipient crossing; prior root within 14 days; exactly one candidate.
- Automated, bulk, and list mail never subject-merge. Content/body similarity is never protocol-conversation evidence.
- Evaluate subject fallback only inside one complete, exact subject bucket. Skip and record buckets above the safety cap; never truncate one and treat it as complete.
- Conversation reads and search deduplicate by delivery key. Whole-thread IMAP mutations must still fan out to every live physical row.
- Soft-deleted rows remain graph evidence even though ordinary reads/search exclude them. Before hard retention removes one, enqueue every surviving component member and subject bucket across every live run; retain a pathological fan-out rather than leave known-stale survivors.
- New/mutated threading inputs and newly recovered body evidence must enqueue idempotently for every active, candidate, and rollback run. Preserve both repository enqueueing and the database trigger: the latter is the rolling-deploy backstop for old writers. A drain expands the affected RFC/provider/prior-conversation closure and the persisted raw/parsed/authored/exact-metadata delivery-fingerprint closure; otherwise bounded pages can permanently split mirrored copies. Persist only namespaced fingerprint hashes in assignments and include them in the criteria cap. The closure has hard row, evidence-byte, and criteria-key caps. The default evidence cap is 32 MiB, sized above a measured 16.92 MiB production closure while remaining fail-closed and independently overridable. If an aggregate multi-seed protocol page hits a closure cap, persist half its seed batch and retry promptly; repeat down to one seed. Never subdivide an exact subject bucket, and never let a one-seed closure bypass a cap.
- Mirror writes take `FOR SHARE` on `imap_thread_state`; build/activation/rollback take `FOR UPDATE`. Preserve this lock order and READ COMMITTED activation checks so activation sees a writer that committed while it waited. The evidence clock, caught-up revision, empty queues, coverage check, and current passing comparison certificate are all required before replacement activation.
- A new threading release must retain the previous pure algorithm executor while that version can be active or standby. Register literal versions explicitly; worker startup and direct drain/rebuild/activation paths must fail fast when a state-referenced executor is absent. All state-referenced versions remain independently caught up; an old binary must never silently ignore or supersede a newer candidate.
- Thread-run scheduling is persisted on `imap_thread_state`: active receives three weighted slots while standby and building each receive one. Preserve bounded progress for all available roles across restarts; sustained active ingress must not starve rollout or rollback work.
- When an exact subject bucket grows past its cap, invalidate any existing `subject_fallback` assignments before marking it skipped. Ambiguity may split a weak conversation; it may never preserve a known stale false merge.
- Initial builds, rebuilds, and algorithm upgrades are shadow runs. They keyset-scan bounded pages, drain changes that arrived during the scan, and stop at `ready`; they never switch readers automatically.
- Shadow scans page on immutable physical message UUIDs. Catch-up repeatedly enqueues any physical row without an assignment; `ready` is unreachable until that repair query finds none.
- The ordinary worker may execute up to ten independently bounded projection steps per account per tick, under a 20-second lane budget. Preserve both caps so large builds progress without delaying mailbox sync.
- Activation requires complete physical-row coverage and empty catch-up queues, then swaps the active-run pointer atomically. A worker must reject a run newer than its compiled algorithm version without updating it.
- Incremental drain and full rebuild must call the same pure, versioned algorithm. Repeating a computation over unchanged inputs must not create a material generation.
- Material assignment changes require an operation row and per-message before/after history. Incremental rollback may reverse only the latest material operation in the active run. Activation rollback requires a caught-up standby. Both must record a rollback operation and pause automatic work pending a clean rebuild.
- Assignment history must survive hard message and projection-run retention. Missing history or a missing current assignment makes rollback fail closed.
- Thread work uses its own account-scoped session advisory lock. It does not authorize an IMAP command and must not borrow or weaken the IMAP account-lock contract.

## Concurrency And Connections

- One IMAP operation per account at a time across worker and API.
- Direct `sendMessage` and `sendDraft` share that account lock. Draft send acquires
  before a possibly-live raw fetch; both hold through SMTP, Sent APPEND, and
  appender teardown, with draft cleanup also inside the same lock.
- Lock acquisition must fail closed when its initial heartbeat cannot persist.
  Long outbound operations refresh heartbeat below `STALE_HEARTBEAT_MS` for their
  full lifetime so stale-lock recovery cannot terminate live work.
- Before irreversible SMTP, the lock lease must synchronously prove both heartbeat
  persistence and ownership by the exact current Postgres session. Transient
  refresh errors retry; known-lost/unknown liveness cannot cross that boundary.
- `pg_advisory_unlock` must return true. False/error destroys the pool client rather
  than returning a possibly lock-owning session to the pool.
- Send lock contention must raise `AccountBusyError` before delivery. Once SMTP is
  confirmed, heartbeat/unlock, SMTP transport close, APPEND, appender teardown,
  and draft-cleanup failures are warnings, never thrown retry signals.
- Use session-scoped Postgres advisory locks, not transaction locks.
- `DATABASE_URL` must be direct or session-affine. Transaction poolers are unsafe for this architecture.
- `DATABASE_POOL_MAX` (default 10) caps Postgres connections per process. It does not change advisory-lock semantics: each pooled connection is its own session. Raise it for many concurrent accounts; keep it within a connection-capped pooler's limit.
- Every runtime Postgres pool must handle its `error` event. node-postgres has already removed an idle client before emitting this event; log the lost session and let a later checkout reconnect. Never let database restart/failover or administrator termination of an idle session become an uncaught process exception.
- Worker startup must fail if advisory lock self-test fails.
- Every runtime ImapFlow client must have an `error` listener before connecting. Promise rejection remains the command/error contract, but EventEmitter's special unhandled `error` behavior must never turn a late event after intentional cancellation into a process crash. Combined API+worker mode installs the worker process handlers with an owner-level close callback before worker startup checks; SIGTERM/SIGINT and fatal events stop the worker and close the API immediately, cancel the lock-test retry budget, and skip later startup maintenance, while fatal events also retain a nonzero process exit status.
- Stale lock recovery must be heartbeat-based and conservative.
- Stale lock recovery also closes the dead worker's open `imap_sync_runs` row (`status='failed'`, reaped error note) so it stops reading as a perpetually running sync. It must only touch stale accounts; a live account with a fresh heartbeat is left running.
- `MAX_LOCK_HOLD_MS` is a cooperative fairness budget. It is checked at safe boundaries, not by killing in-flight IMAP commands. A history metadata batch that has already finished its IMAP fetch persists and advances its watermark under its own bounded database-write deadline before yielding.
- Priority folders may finish past the lock budget; non-priority folders and body batches stop at the next safe boundary.
- A `hitLockBudget` cycle is normal completion and must not reset backoff counters.

## Folder And UID Semantics

- Folder discovery must not treat one empty or missing `LIST` result as authoritative deletion.
- Missing folders get a grace period before being marked `MISSING` and tombstoning in-window rows.
- Exclude dangerous/system folders such as Spam/Junk, Trash/Deleted, and All Mail by default. Drafts are mirrored (real user-authored mail), not excluded.
- Do not exclude Archive by default.
- Folder-count caps warn at the configured threshold and enforce by tracking only priority folders; current provider count is based on the latest successful LIST, so accounts recover automatically when the provider folder count drops.
- Missing-mailbox errors must move the folder to `PENDING_VERIFICATION`, stamp `missing_since`, and set `next_folder_discovery_at = now()` on the account.
- `PENDING_VERIFICATION` folders are not scheduled for normal sync; rediscovery can move them back to `PENDING` when they reappear.
- UIDVALIDITY changes invalidate prior UID references for that folder.
- UIDVALIDITY reset must soft-delete old in-window rows, reset folder sync state, and eventually mark pathological accounts `BROKEN`.

## Sync Semantics

- Current default sync edges:
  - Live sync window is `WINDOW_DAYS=90` days.
  - Inbox/new mail is polling-based and usually detected in about 1-2 minutes.
  - Sent metadata has a separate 30-second default cadence. Its lightweight pass skips discovery, flag scan, reconcile, bodies, history, and full-account health/backoff transitions.
  - Supplemental Sent work must yield at the next full-sweep deadline: abort connection setup, throttle waits, or the active Sent connection; start no further Sent accounts; and re-check the full lane without another poll sleep. Any Sent-lane account-lock contention yields without stale-lock recovery. These yields are not outage/failure signals.
  - Folder discovery runs every 15 minutes.
  - Message delete/move detection depends on reconcile, defaulting to about 6 hours per folder.
  - Folder disappearance gets a 7-day grace period before in-window rows are tombstoned.
  - Each account cycle processes up to 10 priority folders and 5 round-robin folders.
  - Inbox remains first in bounded full-sweep priority selection. Sent stays at priority 5 and receives a supplemental lightweight refresh on its separate cadence.
  - Body fetch is capped at up to 100 live bodies per worker tick.
  - Raw MIME fetch is capped at 25 MB per message.
  - Account lock budget is 10 minutes.
  - Default architecture cap is 20 accounts.
- The real active cutoff currently comes from global `WINDOW_DAYS`; do not claim per-account `live_window_days` changes the sync cutoff until that path is implemented.
- Treat historical/deep-archive backfill as separate from the live-window health path. Issue #2 is open, so do not describe deep archive completeness as done without revalidating the issue acceptance criteria.
- Initial sync is folder-level, snapshot-based, newest-first, and resumable.
- Initial sync SEARCH/FETCH work is bounded by `INITIAL_SYNC_BATCH_TIMEOUT_MS`; a timeout aborts the IMAP client and must not advance the initial-sync watermark.
- A failed initial sync batch must not advance watermarks.
- `live_window_days` is immutable after account creation in v0.1; changing it requires a future window-status migration story.
- `imap_account_progress` is a roll-up view over folder counters. It is a read model, not an independent source of truth.
- Account sync runs as three ordered lanes under one advisory lock: hot metadata/reconcile, capped live body backlog, then history.
- History lane work must never run before hot sync or the live body lane, and it must stop when the cooperative lock budget is exhausted.
- Historical backfill uses the folder `backfill_*` state and `last_archive_refresh_at`; it snapshots older-than-window UIDs and walks them newest-first in resumable batches.
- `historical_backfill_mode = 'off'` disables history work. `metadata_only` mirrors historical headers only. `metadata_and_bodies` fetches historical bodies too.
- Incremental sync only advances `last_uid` after all fetched metadata for the batch succeeds.
- Partial metadata fetches are hard failures. Do not swallow per-message errors and advance cursors.
- Metadata, history, and flag batch sizes are capped at 500 at configuration and repository boundaries. A metadata FETCH or direct logical write fails closed at an estimated 32 MiB or 20,000 retained attachments. Persistence keeps the logical batch atomic while splitting SQL statements at 8 MiB or 5,000 attachments; a single record beyond either statement boundary fails closed. Flag FETCH retention is capped at 4 MiB or 20,000 keywords; projected updates and events split at 1 MiB or 5,000 keywords using both stored and incoming representations and reject a pathological single UID.
- `metadataRowsCommitted` counts acknowledged message-record upserts, including conflict updates (not new-email count or attachment rows). Write-service rate divides those rows by cumulative persistence-path time; worker throughput divides them by monotonic tick wall time. Failed batches add service time and zero rows; no-batch or incomplete mixed-version telemetry reports no rate.
- Flag scans are due-based, compare normalized flags, and keep FETCH/write locks bounded to incremental-size batches under one overall deadline.
- Reconcile only runs after initial sync is complete for the folder.
- Reconcile must handle both sides: mark provider-missing local rows and backfill missing-in-DB provider UIDs.
- Reconcile gap telemetry describes drift observed before repair; `last_reconcile_clean` and account health describe the mirror after repair. A pass that tombstones every provider-missing row and backfills every returned missing-in-DB UID is clean even when `reconcile_gaps_found` is nonzero.
- Missing-in-DB repair is bounded to 5,000 UIDs per pass and must detect overflow with a sentinel row. Overflow, lock-budget interruption, or incomplete backfill leaves reconcile unclean and schedules another reconcile on the next full-sync cadence instead of the normal six-hour cadence.

## Health And Backoff

- Health must not lie.
- Accounts remain `INITIAL_SYNC` while tracked folders are incomplete.
- Accounts remain or become `DEGRADED` when priority lag, unresolved reconcile drift, folder missing, UIDVALIDITY reset, or timeout semantics require it. Drift fully repaired in the same reconcile pass is not unresolved.
- Long-stuck `DEGRADED` accounts with no priority success escalate to retryable `BROKEN` (`STUCK_DEGRADED_24H`) and then terminal `BROKEN` (`STUCK_DEGRADED_TERMINAL`) if recovery keeps failing.
- `AUTH_ERROR` is non-retryable and pins the account `BROKEN`.
- Credential replacement must hold the account advisory lock, reset auth backoff/counters, and leave the account `DEGRADED` with `CREDENTIALS_UPDATED_PENDING_SYNC` until sync proves health.
- `PARTIAL_SUCCESS` increments success counters only when priority folders succeeded and round-robin folders failed.
- Backoff must be conservative, jittered, and reset only after stable success.

## Retention And Safety

- Expiry marks old rows `EXPIRED`; it does not hard-delete them.
- Purge is a strict safety valve for trapdoor delete reasons only.
- Do not purge `RECONCILE_MISSING` rows.

## Verification Anchor

If a change touches any invariant in this document, run the heavy reliability gate:

```bash
pnpm test:db:live
```
