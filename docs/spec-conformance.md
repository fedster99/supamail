# Spec Conformance

SupaMail was extracted from an older Rackspace IMAP sync design that was used to build the original Signal sync engine. This document is the public, sanitized conformance map: it records which reliability mechanics were imported, how SupaMail implements them, and what proves they work.

The private source context is kept outside the public repo in `.context/old-spec-used-to-build-original-signal-sync-engine.md`.

This file is not a full copy of the old spec. It keeps the portable mailbox-mirror contract and omits private Signal product behavior.

## Operating Contract

SupaMail owns a conservative mailbox mirror:

- Postgres is the source of truth for mirrored state; IMAP is the provider being observed.
- The hot mirror window is based on IMAP `INTERNALDATE`, not the RFC `Date` header.
- Metadata, folder state, flags, body fetch state, sync events, and health are durable.
- Full MIME bodies are fetched according to a mutable account policy and always behind the same account lock.
- Multi-folder moves are normal. A message that leaves one folder may still appear elsewhere with a different folder-scoped UID identity.
- Physical mailbox rows, duplicate delivery copies, and protocol conversations are separate identities. Conversation assignment is derived and replaceable; it does not redefine mailbox-row identity.
- Mailbox identity is not CRM identity. SupaMail does not resolve people, companies, handles, relationships, or hydrated activities.
- Threading stops at protocol conversations. It does not cluster separate conversations by task, document, decision, or semantic similarity.
- The architecture is intentionally stateful and account-capped. Scaling beyond the default account cap requires a new architecture decision.

## Reliability Matrix

| Old spec requirement | SupaMail status | Implementation / proof |
| --- | --- | --- |
| UIDs are scoped by folder and UIDVALIDITY, never globally unique. | Implemented | Message uniqueness is `(account_id, folder_path, uidvalidity, uid)`; `pnpm spec-conformance` covers UIDVALIDITY behavior. |
| Message-ID is useful but not authoritative identity. | Implemented | Raw and normalized Message-ID are stored for lookup and correlation, but uniqueness is still folder/UIDVALIDITY/UID-scoped. |
| Mirrored copies and reply conversations must not be one identity. | Implemented | `imap_thread_assignments.delivery_key` groups provider-verified copies or strict-Message-ID candidates sharing a raw-MIME, full-parsed, or conservative transport-invariant authored token while `conversation_id` groups the transitive reply component; Message-ID alone never collapses reused IDs, reads/search collapse verified copies, and mailbox mutations retain every live physical UID target. |
| RFC reply headers should outrank heuristics. | Implemented | The versioned threading algorithm uses valid `References`, otherwise the first valid `In-Reply-To`; strict Message-ID comparison is case-sensitive, malformed tokens are ignored, and cycle guards prefer a split over an invented edge. |
| Missing parents and out-of-order sync must converge. | Implemented | Unresolved referenced Message-IDs are provisional graph nodes. Siblings can share that parent before it is mirrored, and a later parent materializes the same node during deterministic recomputation. |
| Provider/subject fallback must be bounded and account-scoped. | Implemented | Namespaced provider delivery/thread IDs are scoped to an account. Subject fallback accepts only an unlinked, non-automated `Re:` with exact base subject, reciprocal exact participants, a 14-day window, and exactly one candidate; forwards/content similarity never merge, and partial incremental universes disable the weak rule. |
| Conversation assignments must be recomputable and reversible. | Implemented | Thread-relevant input changes enqueue a bounded closure recompute; full rebuild uses the same versioned pure executor and immutable UUID keyset cursor. Catch-up repairs every missing assignment before readiness. Assignments store method/evidence/confidence signals via provisional state/version/hash/generation, operations record outcomes, incremental history stores reversible before/after snapshots, and only the latest material operation can roll back. |
| Credentials must not be stored or logged in plaintext. | Implemented with deliberate divergence | SupaMail encrypts IMAP passwords in Node with AES-256-GCM instead of old SQL crypto examples. Credential replacement is serialized by the account advisory lock and leaves health pending a successful sync; see ADR 0002. |
| Do not run concurrent IMAP operations for the same account. | Implemented | Session advisory locks in `withAccountLock`; live DB tests verify concurrent sync serialization. Direct and draft sends share this lock across raw fetch, SMTP delivery, Sent APPEND, teardown, and draft cleanup. |
| Advisory locks require session-affine Postgres connections. | Implemented | Worker startup self-test fails fast when session lock semantics are broken; deployment docs require direct/session-affine DB access. |
| Detect broken advisory lock/session assumptions. | Implemented | Worker lock self-test verifies session-scoped lock behavior at startup. |
| Recover stale/orphaned account locks. | Implemented | Stale heartbeat recovery scans `pg_locks`, terminates stale backends, and closes the orphaned `imap_sync_runs` rows a dead worker left `running`; live DB tests cover both the held-lock path (real `pg_locks`) and the SIGKILL/OOM path (no lock to terminate), asserting the reaped run is marked `failed` while a live account's run is left untouched. |
| A sync run must not stay `running` after an in-process exception. | Implemented | `MirrorEngine.syncAccount` terminalizes an opened run before rethrowing unexpected account-lock, recovery, or finalization errors; focused regression coverage reproduces a Postgres pool-checkout failure immediately after run creation. Stale-heartbeat reaping remains the crash/OOM backstop. |
| IMAP commands should be bounded and provider-friendly. | Implemented | IMAP operations use command timeouts and a per-connection token bucket controlled by `IMAP_MAX_COMMANDS_PER_MINUTE`. Every runtime ImapFlow client also installs an `error` listener before connecting so a late lifecycle event after intentional cancellation cannot trigger EventEmitter's process-fatal unhandled-error behavior; combined runtime process handlers stop the worker, close the API, cancel retry waits, and skip later startup maintenance even during startup, while preserving a nonzero exit status for fatal events. |
| Mailbox operations must avoid mailbox switching races. | Implemented | Folder sync and body fetch use ImapFlow mailbox locks before folder-specific operations. |
| Sync scheduling uses priority folders plus bounded round-robin. | Implemented | `PRIORITY_CUTOFF`, `MAX_PRIORITY_FOLDERS_PER_CYCLE`, `MAX_RR_FOLDERS_PER_CYCLE`, and `folder_rr_cursor` prevent lower-priority folder starvation. Inbox remains first in the bounded full-sweep set; Sent also receives a lightweight 30-second metadata lane without multiplying reconcile/body/history work. |
| Initial sync must be resumable and gap-safe. | Implemented | Snapshot + newest-first watermark; spec-conformance runs three-cycle initial sync proof. |
| Initial sync batches must not stall forever. | Implemented | `INITIAL_SYNC_BATCH_TIMEOUT_MS` bounds initial snapshot/search/fetch work, aborts the IMAP client on timeout, and does not advance the watermark; spec-conformance Scenario H proves retry resumes from the same watermark. |
| Do not reconcile unfinished initial sync folders. | Implemented | Reconcile runs only after initial sync completion; health remains `INITIAL_SYNC` while any tracked folder is incomplete. |
| Incremental sync must not advance through partial metadata fetches. | Implemented | Metadata fetch fails if any requested UID is missing; unit coverage pins partial-batch behavior. |
| Incremental sync must respect a hard operation deadline. | Implemented | `INCREMENTAL_TOTAL_TIMEOUT_MS` aborts IMAP work, treats the cycle as transient failure, and does not advance `last_uid`. |
| Reconcile provider deletes and missing-in-DB rows. | Implemented | Temp-table UID stream finds missing local rows and provider-only rows; live DB tests verify provider tombstones and `RECONCILE_BACKFILL`. |
| Reconcile health must describe post-repair state. | Implemented | Observed gaps remain run telemetry, while fully repaired provider deletes or missing-in-DB rows finish with `last_reconcile_clean = true`; bounded overflow or interrupted repair remains degraded and retries on the next full-sync cadence. |
| Reconcile must be staggered and budgeted. | Implemented | `next_reconcile_at`, `RECONCILE_INTERVAL_MS`, and `MAX_RECONCILES_PER_CYCLE` keep clean reconciliation due-based instead of every-folder/every-cycle; incomplete repair retries early. |
| Flag scans are due-based and diff actual flag changes. | Implemented | `applyFlagScan` compares normalized old/new flags, logs `FLAGS_CHANGED`, and does not backfill unknown UIDs. |
| Flag scans must be budgeted. | Implemented | Priority and round-robin flag scan intervals are separate, and `MAX_FLAG_SCANS_PER_CYCLE` limits per-cycle work. |
| Exclude folder explosions such as Spam/Trash/All Mail by default. | Implemented | Provider profiles exclude dangerous/system folders including SPECIAL-USE `\All` and `All Mail`. |
| Archive-like folders are not excluded by default. | Implemented | Provider profile tests cover that archive folders stay trackable unless explicitly configured otherwise. |
| Generic IMAP support must be validated provider by provider. | Implemented | `docs/imap-compatibility.md` defines the minimum contract, provider matrix, and manual smoke checklist; `provider-compatibility.integration.test.ts` covers deterministic protocol fixtures; GreenMail and Dovecot smokes cover two real IMAP server implementations. |
| Folder-count explosions must not silently overload sync. | Implemented | `FOLDER_COUNT_WARN_THRESHOLD` adds `MANY_FOLDERS_PERFORMANCE_NOTE`; `FOLDER_COUNT_ENFORCE_THRESHOLD` keeps only priority folders tracked with `TOO_MANY_FOLDERS_REQUIRES_MANUAL_CONFIG`; spec-conformance Scenario J proves warn, enforce, and auto-recovery. |
| Missing folders get a grace period before tombstoning. | Implemented | Folder discovery stamps `missing_since`; past grace marks folder `MISSING` and tombstones in-window rows. |
| Missing-mailbox folder operations should force rediscovery. | Implemented | Missing-mailbox errors move the folder to `PENDING_VERIFICATION`, stamp `missing_since`, set `next_folder_discovery_at = now()`, and pause normal scheduling until discovery resolves it; spec-conformance Scenario K proves the full path. |
| UIDVALIDITY resets trigger controlled resync and a rolling reset cap. | Implemented | Reset handler tombstones old rows, resets folder state, and marks account `BROKEN` after the configured 24h cap. |
| Health must not lie. | Implemented | Account health stays `INITIAL_SYNC`/`DEGRADED` until tracked folders, lag, and post-repair reconcile state are actually clean; repaired pre-pass drift remains observable without pinning stale degraded health. |
| Stuck `DEGRADED` must escalate without hiding recovery forever. | Implemented | `last_priority_sync_succeeded_at` drives retryable `STUCK_DEGRADED_24H`, hourly retry via `backoff_until`, terminal `STUCK_DEGRADED_TERMINAL`, and recovery on successful priority sync; spec-conformance Scenario I proves it. |
| Partial success is not a hard failure when priority folders succeed. | Implemented | Priority failure makes sync failed; round-robin-only failure is `partial_success` and increments success counters. |
| Backoff should be conservative and jittered. | Implemented | Transient failures use jittered exponential backoff; stored backoff resets only after stable success. |
| Retention must preserve recoverable reconcile tombstones. | Implemented | Expiry marks old rows `EXPIRED`; purge only removes strict trapdoor reasons, never `RECONCILE_MISSING`. |
| Account count should be capped for this architecture. | Implemented | `SYNC_MAX_ACCOUNTS` enforced at account creation and worker startup. |
| Body fetches should be policy-controlled and lock-guarded. | Implemented | Body backlog/fetch uses the same account lock. A 32 KiB plain-text search extract and threading evidence commit before the pluggable `BodyStore` receives the full payload; database bodies remain the OSS default. `PATCH /accounts/:id/settings` can change `bodyFetchPolicy` to `immediate`, `lazy`, or `priority_then_backfill` for an existing account. `BODY_STORAGE_MODE=parsed_only` streams the IMAP download through raw byte counting/SHA-256 and MIME parsing without retaining the source; the default `raw_mime` mode buffers only because raw persistence requires it. |
| Body completeness should be observable because downstream search reliability depends on it. | Implemented | `imap_account_progress` derives live and priority body coverage from current active `IN_WINDOW` messages and counts only store-completed, non-truncated body rows as complete. An evidence-only row does not produce false completion. Cumulative folder counters remain telemetry for headers and history rather than proof of current live-body coverage. Scenario M proves the roll-up contract; real-Postgres Scenario R proves post-snapshot rows and truncated bodies cannot produce false full coverage. |
| Historical backfill should not starve fresh mail. | Implemented | The engine runs hot, body, then history lanes under one advisory lock; history is resumable through folder `backfill_*` state and skipped when the body lane exhausts the lock budget. An already-fetched history batch persists under a separate bounded database deadline before yielding at the safe boundary, so the cooperative lock budget cannot turn completed IMAP work into repeated failures. Spec-conformance Scenario L and the history safe-boundary integration regression prove ordering and budget behavior. |
| Attachment metadata belongs in the mirror, not necessarily attachment binaries. | Implemented | MIME `BODYSTRUCTURE` is parsed into attachment metadata during sync; binary attachment retrieval is outside the current core path. Decoded full-body parsing hashes attachment streams and buffers only bounded calendar payloads, then stores SHA-256/calendar/provider-resource evidence rather than attachment bytes. |
| Structured artifact evidence must remain separate from conversation and work-item truth. | Implemented | `0016_message_evidence` stores versioned neutral evidence and extraction coverage. SupaMail does not cluster tasks: attachment identity, calendar occurrence, and provider resource keys cannot alter `conversation_id`. |
| Worker shutdown should release held resources. | Implemented | SIGTERM/SIGINT propagate into active full-sync work, close IMAP, explicitly release the account advisory lock, clear active-sync state without changing mailbox health, and then close the Postgres pool. Live DB tests prove no account lock remains after cancellation. |
| Sync should emit durable observability events. | Implemented at mirror-event level | Sync runs, message/folder events, flag changes, reconcile backfills, and retention outcomes are stored or logged. Worker logs preserve sanitized error class/code/provider context, emit failed account outcomes at error severity, and emit partial outcomes at warning severity. Sync-run metadata exposes acknowledged message-record upserts, cumulative persistence time, attempted/failed batches, and write-service rate; tick logs separately expose rows over monotonic wall time as production throughput. Failed attempts add time but zero rows, and incomplete telemetry emits no aggregate rate. Normal idempotent API shutdown is silent; genuine close failures remain error-level events. Alert thresholds remain an open operational layer. |
| CI must prove DB behavior against real Postgres. | Implemented | `pnpm test:db:live` starts disposable Postgres, migrates twice, runs live DB integration tests, then runs spec conformance. |

## Imported Detailed Semantics

### Identity And Normalization

The mirror stores both raw and normalized Message-ID values, but they are correlation helpers only. They must not replace the primary mirror identity of account, folder path, UIDVALIDITY, and UID. The conversation algorithm parses valid RFC Message-ID tokens separately and compares their canonical syntax case-sensitively; the legacy lowercased normalized value is not threading truth.

Threading then builds two derived layers without changing that primary identity. A delivery key identifies verified physical copies, preferring namespaced provider message identity and using strict Message-ID plus a shared raw-MIME, full parsed-representation, or transport-invariant authored-representation token to guard against reused IDs. The authored token is restricted to complete, non-truncated bodies with complete structured/attachment evidence; it ignores provider-added trace/authentication headers and wire sizes but includes the original Message-ID/Date, envelope, stable MIME headers, all parsed body variants, MIME structure, parser warnings, and structured evidence digest. V3 may also join same-Message-ID candidates when timestamp, byte size, normalized subject, sender, and all recipients match exactly and the components occupy distinct folders; a same-folder candidate or conflicting authored digest vetoes that fallback. Raw/full-parsed disagreement is not negative evidence because transport and storage representations can differ. Eligible metadata matches request authored corroboration. A conversation ID identifies the transitive account-scoped component built from those deliveries. Search and conversation reads choose one deterministic physical representative for each delivery; IMAP flag/move operations still address every live physical row because each copy has its own folder and UID.

Valid `References` supplies ancestry. Only when it yields no valid token does the first valid `In-Reply-To` supply a parent. Missing tokens remain provisional nodes so siblings and later-arriving parents converge. A directly prefixed forward starts a new authored protocol conversation even when a client inherited reply or provider-thread evidence; replies to that forward may form their own branch. Provider thread IDs otherwise add account-scoped membership but never invent parentage. The final subject fallback is intentionally weak and narrow, and is disabled whenever a bounded incremental drain cannot prove it has a complete candidate universe. Content/body similarity is never protocol-conversation evidence.

This is mailbox/protocol identity only; it must not grow into CRM identity hydration, person/company resolution, handle mapping, activity construction, or work-item clustering inside SupaMail core. Flags are normalized case-insensitively, de-duplicated, sorted, and compared as sets.

### Conversation Projection Operations

New or changed threading inputs are upserted into a separate `imap_thread_work_queue` row for every active, candidate, and rollback run. A database trigger also advances an evidence clock and enqueues changes, closing the rolling-deploy gap when an older writer lacks repository instrumentation. When v2 or later observes different delivery candidates under one strict Message-ID, a protected queue reason requests their targeted authored digests; the normal deadline and body batch cap apply, and only an exact resulting match collapses the copies. The ordinary worker advances up to ten independently bounded steps per eligible account after full and supplemental Sent sync passes, under a 20-second lane budget. Each step expands the affected delivery/reference/provider/prior-conversation and persisted delivery-fingerprint closure under row/evidence/criteria budgets and records a generation only when material assignments change. A multi-seed protocol page that exceeds a closure budget persists a halved batch hint and retries promptly until it succeeds or proves that one seed is itself unsafe. Exact subject buckets are never subdivided: buckets with fewer than two distinct eligible deliveries and no existing weak assignment are retired in audited batches, while overflow dissolves prior weak merges before skipping ambiguity. Other failures retain exponential backoff before releasing the account lock.

Migration `0014_conversation_threading` performs no mailbox-wide backfill. Initial builds and algorithm upgrades are versioned shadow runs: bounded body-evidence and protocol keyset scans are followed by subject buckets and a catch-up stage. `threads-drain --account-id` runs one bounded step; `threads-rebuild --account-id` builds a complete shadow; `threads-compare` persists thresholded metrics for exact generations/evidence revision; confirmed `threads-activate` requires that current passing certificate, coverage, and empty queues before atomically switching the active view; confirmed `threads-rollback` reverses a rollout pointer or the latest active material operation and pauses work pending a clean rebuild. Deployments may opt into automatic activation only for a first `mode='initial'` projection after the same coverage, caught-up evidence revision, and empty-queue checks pass. The scheduler keeps that ready first run eligible until activation commits, so process failure or transient lock contention cannot strand it. Upgrades and rebuilds remain explicit and comparison-gated. A dedicated account advisory lock serializes thread workers, while a shared/exclusive `imap_thread_state` row lock closes the race with mirror writes; neither lock authorizes an IMAP command. A persisted three-active/one-standby/one-building schedule prevents sustained ingress from starving rollout work. Literal version executors keep the active, shadow, and standby projections current during rolling upgrades; startup and direct operator paths fail fast if a referenced executor is absent.

### Folder Discovery And Scheduling

Folder discovery is due-based and persists provider seen/missing state. Full sync cycles process priority folders first, then a bounded number of non-priority folders using a stable round-robin cursor. Inbox remains first in that bounded priority set. Sent retains its normal priority 5 position and gets a supplemental due-based metadata refresh on the separate fast lane. The cursor advances by attempted folders so one bad lower-priority folder cannot starve the rest.

Between full sync cycles, a separate due-based Sent lane refreshes metadata at `SENT_SYNC_INTERVAL_MS` (30 seconds by default). It uses the same account and mailbox locks but deliberately skips discovery, flag scans, reconcile, body fetch, history, and full-account health/backoff transitions. Its durable sync run remains observable without advancing the account's full-sweep `last_sync_finished_at`; the next full cycle owns account health. The next full-sweep start is a hard deadline for supplemental Sent work: pending connection or throttle work and the active IMAP connection are interrupted, no more Sent accounts start, and the worker rechecks the full lane immediately. Any Sent-lane account-lock contention yields without stale-lock recovery. These scheduler yields are neutral rather than false provider-failure events.

Flag scans and reconciles are also due-based and budgeted. Agents should not change this into "scan every folder every cycle" behavior; that is exactly the folder-explosion failure mode the old spec was trying to prevent.

Historical backfill runs after hot sync and the capped live body lane. It snapshots older-than-window UIDs per folder, walks them newest-first, and persists progress in the folder `backfill_*` fields. Backfill *completeness* does not gate `sync_state` health (an account is not DEGRADED for incomplete history), though a history-lane *error* surfaces in the sync run outcome like other lane errors. Progress consumers should read `imap_account_progress` and per-folder progress rows.

The live body lane reads `body_fetch_policy` on each account run. `immediate`
includes all active live-window messages, `lazy` leaves automatic backlog
fetching off, and `priority_then_backfill` includes only folders at the priority
cutoff. The last name does not promise later live-body coverage for current
non-priority folders; the history lane is separate and only handles
older-than-window mail.

Live and priority body coverage is a current evidence claim. Its denominator is
active `IN_WINDOW` messages in tracked folders whose `missing_since` is NULL and
whose status is neither `MISSING` nor `PENDING_VERIFICATION`, excluding
provider-deleted rows. Its numerator requires a matching
`imap_message_bodies` row with `raw_truncated = false`. Truncated rows remain
incomplete but do not enter an automatic retry loop. Explicit refetch is useful
only after the cause is corrected; a cap-limited message requires a higher
`BODY_RAW_MAX_BYTES` first. Per-folder `live_bodies_fetched_count`,
`live_bodies_target_count`, and `bodies_pct` use the same completeness test
within each returned folder. They also report untracked, missing, and pending
folders, which the active account roll-up excludes. Folder targets therefore do
not always sum to the account target. Live, priority, and per-folder current
body percentages report 100 only when the fetched count reaches the target;
incomplete ratios are floored. Migration
`0021_row_accurate_body_progress` adds the partial
`imap_messages_live_body_progress_idx`; large existing mirrors must prebuild
that exact index concurrently before applying the transactional migration.
Cumulative folder counters remain operational telemetry.

### IMAP Connection And Lock Discipline

All account-scoped IMAP work goes through the account advisory lock. `sendMessage` and `sendDraft` additionally hold that lock across their full outbound provider sequence; lock contention rejects before delivery with a transient `AccountBusyError`. Initial heartbeat persistence and exact `pg_locks` session ownership are fail-closed, transient refresh errors retry, and long sends refresh below `STALE_HEARTBEAT_MS`. Liveness is synchronously re-proven before SMTP, then delivery confirmation changes later heartbeat/unlock/transport-close failures into warnings rather than retry signals. Advisory unlock must return true; false/error evicts the pool client. Folder-specific work takes an ImapFlow mailbox lock before reading UIDVALIDITY, syncing metadata, scanning flags, reconciling, or fetching a body. IMAP commands are throttled and timeout-bounded; failed or timed-out operations must not advance sync cursors.

### Health, Backoff, And Retention

Health is a reliability statement, not a cosmetic status. `HEALTHY` requires completed initial sync, fresh priority folders, acceptable overall lag, and recent clean reconciles. `DEGRADED` is the correct state for drift, priority lag, missing folders, UIDVALIDITY resync, or incremental timeout. `BROKEN` is for non-retryable auth failure and pathological repeated failures.

Retention keeps old mirror rows recoverable. Expiry marks rows `EXPIRED`; purge is limited to strict trapdoor reasons and must not purge `RECONCILE_MISSING` rows.

## Open Deltas From The Old Spec

These old-spec ideas are still useful, but they are not part of the current implemented contract:

- Broader metrics and alerts: metadata write-service efficiency and wall-clock throughput now have distinct structured fields, but this repo does not yet define alert thresholds or a complete production metric catalog.
- Provider-specific live account CI: the open-source project now has a compatibility matrix, deterministic provider-shape fixtures, GreenMail and Dovecot smoke tests, and disposable Postgres. Live provider accounts still require manual smoke runs unless a safe provider-specific CI account is added later.
- UI fallback for body-fetch failures: SupaMail stores metadata and body state, but it does not own an end-user UI contract.
- CRM interaction fallback: the old Signal interaction-resolution behavior is intentionally outside SupaMail core.

## Intentionally Out Of Scope

SupaMail keeps the Signal product layer out:

- Relationship CRM tables and interactions.
- CRM hydration, identity resolution, handle/person/company mapping, belief, and epistemic architecture layers.
- Signal dashboard/API routes.
- Provider-specific live account tests in CI.

The open-source project owns the mailbox mirror: durable metadata, flags, bodies, folders, sync events, health, and reliability semantics.

## Verification Commands

```bash
pnpm test
pnpm test:db:live
pnpm typecheck
pnpm build
```

`pnpm test:db:live` runs the serious DB reliability gate: disposable Docker Postgres, migration idempotence, live DB integration tests, and spec conformance.
