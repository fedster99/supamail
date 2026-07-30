# Session Handoff

## 2026-07-31 — Explicit SMTP delivery outcomes

- Branch `fedster99/fix-smtp-outcome-contract` replaces the false retry
  guarantee from a stable RFC Message-ID. A stable ID helps reconciliation,
  but it does not stop a provider from accepting the same message twice.
- SMTP delivery now returns its accepted recipients, rejected recipients, and
  final response. Failures use `not_delivered` only for a complete SMTP 4xx or
  5xx reply or a proven failure before submission. A partial positive reply,
  lost final reply, or unqualified connection loss is `unknown`.
- Real local SMTP integration tests accept DATA and then either drop the final
  reply or send an unterminated positive reply. They prove the server received
  one message while the core reports `unknown`.
- The HTTP API and CLI expose the stable delivery outcome without provider
  details. Pre-SMTP errors from send and draft-send also carry the typed
  `not_delivered` outcome.
- The private Cloud layer must store an operation before SMTP, retry only
  `not_delivered`, and never submit again after `unknown`.
- Verification passed the harness check, API typecheck, 713 fast tests on
  Vitest 3.2.7, the API build, the root build, and the GreenMail SMTP/IMAP
  smoke with live send and draft delivery. The local shell used Node 26 while
  the repository pins Node 24.
- Next: review the public PR. Merge only with Federico's explicit approval.
  Then wait for the immutable core image and pin it in the Cloud PR.

## 2026-07-30 — Neutral metadata-protection seam

- Branch `fedster99/metadata-protection-adapter` adds the public-core half of
  the Managed metadata-protection boundary. It defines an injectable neutral
  adapter, a readable identity default, and migration
  `0023_metadata_protection_seam`.
- The migration adds nullable opaque envelope, envelope-version, key-version,
  and exact-token columns to accounts, messages, message-body evidence,
  attachments, structured evidence, thread assignments, and retained
  assignment history. It adds no Tenant, hosted key, encryption algorithm, or
  search-provider logic.
- `MirrorRepository` routes account and sync-owned message, attachment, body
  evidence, and structured-evidence writes through the adapter. It reveals
  those rows on repository reads and removes internal envelope columns from
  returned objects. The identity adapter keeps OSS and BYO Supabase readable
  and leaves the new columns `NULL`.
- ADR 0029 records the ownership boundary and activation rule. The seam alone
  does not provide encryption. Managed Hosting must not activate it until the
  private Cloud key/envelope implementation and every search, threading,
  dashboard, MCP, and REST path are protected.
- Review fixes merge retained protected Message-ID/reply values before replacing
  an envelope, skip decryption when a first body-evidence row does not exist,
  preserve legacy partial-row response behavior, and enforce the actual
  PostgreSQL `smallint`/`integer` version bounds.
- The final pre-merge review removed a plaintext-retention path during
  readable-to-protected message upgrades. It also makes adapter writes and
  reveals fail closed on missing or injected fields, records the required
  authenticated context and stable equality semantics, preserves SQL `NULL`
  body digests, and avoids an evidence lookup when no evidence exists.
- The live protected-storage test now starts with a readable message, upgrades
  the same stable rows through a context-bound opaque adapter, and proves that
  the old threading headers do not remain readable.
- Node 24 verification passed `pnpm harness:check`, root typecheck, 706 fast
  tests, both builds, 198 live-Postgres tests, migration apply twice, and
  120/120 spec-conformance checks. The live protected-storage test uses a
  strict opaque test adapter and proves that later metadata sync retains
  body-recovered Message-ID data.
- Next: review and merge the public PR only with Federico's explicit approval.
  Then wait for the immutable image and implement the private Cloud crypto and
  storage PR before any activation.

## 2026-07-28 — Dependency security remediation

- Branch `fedster99/fix-dependency-alerts` clears the 43 open GitHub
  Dependabot alerts (two critical) present on `main`. The investigation began
  with 42 alerts; GitHub added a PostCSS alert during final review, and the
  branch already resolves it with PostCSS 8.5.24. The original lockfile
  reproduced 47 vulnerable dependency paths through `pnpm audit`; the updated
  graph reports no known vulnerabilities.
- Direct upgrades move Vitest to the patched v3 line, Next.js to patched 15.5,
  Hono and its Node adapter to their patched releases, and refresh IMAPFlow,
  Mailparser, and Nodemailer so their mail/link parsing dependency graph is
  patched.
- Root pnpm overrides keep vulnerable transitive versions out of the lockfile:
  the MCP SDK's Hono adapter, Vitest's Vite/esbuild toolchain, Next.js's
  PostCSS/Sharp toolchain, and AJV's `fast-uri`.
- Node 24 verification passed frozen install, audit, root typecheck, 701 fast
  tests (including a real HTTP listener lifecycle check for the Hono Node
  adapter), both production builds, 197 live-Postgres tests, 120/120
  conformance checks, GreenMail SMTP/IMAP smoke, and Dovecot IMAP smoke. No
  application, schema, migration, protocol, or feature-list behavior changed.

## 2026-07-27 — Single-worker parsed-body throughput (PR #102)

- Branch `fedster99/single-worker-body-throughput` batches small
  `parsed_only` bodies on one IMAP connection. One UID-set FETCH covers at
  most 10 same-folder messages, 4 MiB per message, and 8 MiB of aggregate
  source. Unknown, large, singleton, cap-limited, missing, or size-mismatched
  messages use the individual streaming path.
- The bounded FETCH and MIME parse finish before storage. Each message still
  commits search/threading evidence, then `BodyStore`, then completion. A
  storage failure leaves that message retryable. A missing batch response gets
  an individual download before any `MOVED_OUT` decision.
- The live body lane reads several configured batches with one bounded
  database query. Parsed bodies are grouped by folder inside that selected
  set. Inline and queued historical body work use the same batching helper.
  No schema migration is required.
- A controlled 40-message benchmark with 20 ms command latency reduced IMAP
  body commands from 80 to 4 and median fetch/parse time from 1.73 seconds to
  0.105 seconds (16.46x). A 10-message, 7.5 MiB aggregate source probe added
  11.6 MiB peak RSS.
- Final verification passed 700 fast tests, both builds, 197 live-Postgres
  tests, 120/120 conformance checks, GreenMail in `parsed_only` (3 messages,
  3 bodies, 1 attachment), and Dovecot in `parsed_only` (4 messages, 4 bodies,
  1 attachment). The expected local Node 26 warning appeared because the repo
  pins Node 24.
- Next: review the public PR, merge only with Federico's explicit approval,
  wait for the immutable core image, then re-pin and canary the hosted runtime
  in a separate private-cloud PR.

## 2026-07-26 — Bounded threading rollback history

- Branch `fedster99/bound-threading-history` stops
  `imap_thread_assignment_history` from growing as a permanent audit log.
  Only the latest material change to the active run keeps a full reversible
  delta. Its transaction removes older deltas.
- Candidate and standby changes keep compact operation rows only. Activation
  and successful rollback clear obsolete full snapshots. Existing rollback
  guards and fail-closed behavior remain.
- No schema migration is required. Existing accumulated history is removed by
  the next material active change, activation, or rollback. Wide assignment
  rows are a separate measured optimization.
- Verification passed typecheck, 691 fast tests, both builds, one complete
  190-test live-Postgres gate, and 120/120 conformance checks. After adding
  direct activation/standby cleanup assertions, the complete 50-test threading
  live-Postgres suite also passed. One intermediate full rerun hit the existing
  drain-order timing flake; no bounded-history assertion failed.

## 2026-07-25 — Initial-sync live-head freshness

- Branch `fedster99/initial-sync-live-head` keeps new mail current while a
  folder's frozen initial snapshot is still backfilling. Each initial-sync
  cycle now processes one bounded live-head batch above the snapshot, then one
  newest-first snapshot batch.
- The live head uses the existing monotonic `last_uid`; the frozen snapshot and
  historical watermark remain independent. Completion preserves the larger
  live cursor. No schema migration is required.
- The real-Postgres regression failed first because a new UID remained absent
  until snapshot completion, then passed after the fix. Final verification
  passed 691 fast tests, both production builds, 189 live-Postgres tests, and
  120/120 spec-conformance checks. One intermediate full gate hit unrelated
  threading-suite timing failures; the immediate clean rerun passed all 49
  threading tests.
- Next: review and merge the public PR, wait for the immutable core image, then
  re-pin the private hosted runtime and repeat the controlled new-mail
  freshness proof.

## 2026-07-23 — Content extract and body-store seam

- Branch `fedster99/content-body-store-seam` adds public migration
  `0022_content_extract_body_store`: a 32 KiB UTF-8 `search_extract`, an FTS
  expression index, and `threading_payload_sha256` over every parsed body
  variant. Existing body rows are backfilled without a mailbox rebuild.
- Sync now commits search/threading evidence before an injected `BodyStore`
  receives raw MIME and parsed payload. `DatabaseBodyStore` remains the OSS
  default and preserves `BODY_STORAGE_MODE`, including `parsed_only`.
- Search matches, body filters, ranking, and snippets use the extract. Fuzzy
  recall remains on indexed message headers. Thread delivery evidence can be
  recomputed after envelope corrections from compact evidence without reading
  payload columns. Body progress becomes complete only after the store
  succeeds.
- ADR 0028 records the exact extract input/bound, ordering invariant,
  compatibility behavior, and excluded hosted/storage-provider decisions.
- Verification passed 691 fast tests, 188 live-Postgres tests, 118/118
  spec-conformance checks, typecheck, and both builds. Search eval remained
  nDCG@10 `0.9441428692051971`, Recall@10 `0.953125`, MRR `0.96875`, with all
  four junk guards passing. The expected Node 26 warning appeared locally
  because the repository pins Node 24.

## 2026-07-23 — Mutable live-body policy and row-accurate coverage

- Branch `fedster99/live-body-coverage-policy` lets an existing account change
  `bodyFetchPolicy` through `PATCH /accounts/:id/settings`. The accepted values
  are `immediate`, `lazy`, and `priority_then_backfill`; strict invalid, empty,
  and unknown input remains rejected.
- Public migration `0021_row_accurate_body_progress` replaces
  `imap_account_progress`. Live and priority body targets now come from current
  active `IN_WINDOW` message rows, and only a matching non-truncated body row
  counts as complete. Cumulative folder counters remain telemetry.
- A truncated body remains incomplete but does not enter an automatic retry
  loop. Explicit body refetch is useful after the cause is corrected; a
  cap-limited message needs a higher `BODY_RAW_MAX_BYTES` first. The migration
  adds the partial `imap_messages_live_body_progress_idx`; large existing
  mirrors must prebuild that exact index concurrently before applying the
  transactional migration.
- `GET /accounts/:id` now gives each folder row-current
  `live_bodies_fetched_count`, `live_bodies_target_count`, and `bodies_pct`.
  The cumulative body counter remains available as telemetry. Inactive folder
  targets need not sum to the active account target.
- The public API tracer test failed first with `400` instead of `200`, then
  passed after implementation. Row-accuracy tests also failed first against the
  old counter view. The full gate then passed typecheck, 685 fast tests, both
  production builds, 186 live database tests including Scenarios R and S, and
  118 spec-conformance checks. The local shell emitted the expected Node 26
  warning while the repository pins Node 24.

## 2026-07-23 — OSS GitHub presentation

- Branch `agent/readme-design` gives the public repository a factual visual
  identity: a repository-owned SVG explains the IMAP → SupaMail → Postgres →
  SQL/CLI/MCP loop without provider, maturity, popularity, or storage claims.
- The README now leads with the value proposition, restrained trust badges,
  compact navigation, grouped capabilities, and the quickstart. Deep
  conversation-threading internals are summarized and linked to ADR 0024.
- This is documentation and presentation only. Runtime, schema, migration, API,
  compatibility, and deployment behavior are unchanged.
- `INSTALL_CMD=true ./init.sh`, SVG XML validation, relative-link target checks,
  and `git diff --check` passed. The init gate ran harness review, typecheck, 682
  fast tests, and both production builds; the live-DB gate was intentionally
  skipped because no runtime, schema, or reliability behavior changed. The
  local shell emitted the expected Node 26 warning while the repo pins Node 24.
- PR #94 is ready for review. Its GitHub-rendered README was checked at 375,
  768, and 1280 pixel widths with no overflow or broken assets.
- The README hero was then aligned to the current `www.supamail.dev` landing
  system: warm paper, ink black, Supabase green, editorial serif headline,
  JetBrains-style mono labels, the `~` brand mark, and one terminal surface.
  Product claims and README structure remain unchanged.

## 2026-07-23 — OSS GitHub hygiene and tracker reconciliation

- Revalidated issues #4 and #7 against `main`: the local stdio MCP server and
  agent-oriented CLI are implemented, so their feature-list states are now
  `passing` and the stale GitHub issues can close.
- Revalidated issue #3. Its protocol contract, provider matrix, fixtures, and
  GreenMail/Dovecot smokes exist. The repository-hygiene PR adds a Dovecot job
  beside GreenMail, closing the remaining acceptance gap. Fresh local
  verification passed both real-server smokes, so #3 is now `passing`; close the
  GitHub issue when the PR lands with both required checks green.
- Public docs now describe the shipped CLI/MCP surface accurately. Added
  lightweight security, contribution, and bug-report guidance.
- GitHub-only cleanup covers stale merged branches, obsolete PR #27, repository
  topics/features, merge settings, and security automation. No public-core
  runtime, schema, migration, or image behavior changed.

## 2026-07-19 — Sync-run finalization and opt-in initial thread activation

- `MirrorEngine.syncAccount` now terminalizes an opened durable run before
  rethrowing unexpected account-lock/recovery/finalization exceptions, closing
  the healthy-account phantom-`running` gap left by pool-checkout failures.
- `THREADING_AUTO_ACTIVATE_INITIAL` is an opt-in worker setting. It uses the
  existing atomic activation checks only for a first `mode='initial'` run;
  the scheduler keeps a ready first run eligible until activation commits, while
  rebuilds and upgrades remain explicit and comparison-gated.
- MIME attachment evidence now hashes decoded bytes through `MailParser`'s
  attachment stream, buffering only a capped calendar payload. In `parsed_only`
  mode the complete RFC822 source now streams directly from IMAP through raw
  byte counting/SHA-256 and MIME parsing; no full source buffer is requested or
  retained. `raw_mime` mode keeps its required buffered-storage behavior.
- Focused unit and live-Postgres regressions cover these boundaries, including
  rediscovery after an interrupted first activation. This is a maintainer-directed
  reliability repair, so the feature-list state is unchanged.

## 2026-07-17 — Threading v3 mirror and forward boundaries

- Algorithm v3 adds a high-precision delivery fallback for measured mirrored
  mailbox rows: strict Message-ID plus exact timestamp, byte size, subject,
  sender, and all recipients, with candidates required to occupy distinct
  folders. Same-folder reuse and conflicting authored digests remain split.
  Eligible metadata matches request authored
  corroboration before a shadow run can become ready.
- A directly prefixed forward now starts a new protocol conversation even when
  a client inherited reply/provider headers; replies to the forward can form
  their own branch. Work-item clustering remains the layer for relating the
  original and forwarded conversations.
- Migration `0020_threading_fingerprint_closure` persists hashed raw, parsed,
  authored, and exact-metadata tokens so bounded pages are recomputable and
  agree with a full-account run. V1 and v2 executors remain registered for
  active/standby rollback safety.

## 2026-07-15 — Credential replacement API

- Branch `fedster99/supamail-credential-reconnect` adds authenticated
  `PATCH /accounts/:id/credentials` for password/app-password repair.
- Replacement uses the existing AES-256-GCM envelope under the account advisory
  lock, clears auth backoff/counters, and leaves health `DEGRADED` with
  `CREDENTIALS_UPDATED_PENDING_SYNC` until provider sync proves recovery.
- API and live-Postgres regressions cover validation, encrypted replacement,
  health reset, and exclusion while a sync session owns the account lock.

## 2026-07-15 — Production-sized threading closure evidence

- A real v2 production shadow build expanded a 500-message seed page into a
  legitimate 2,562-message reply component with 17,744,178 bytes (16.92 MiB)
  of measured threading evidence. The 16 MiB default failed closed just below
  that observed requirement; row, criteria-key, and evidence-byte enforcement
  itself behaved correctly.
- Branch `fedster99/raise-threading-closure-cap` raises only the default evidence
  limit to 32 MiB; explicit overrides and the 512 MiB absolute ceiling remain.
  A live-Postgres regression creates an approximately 16.93 MiB evidence page:
  it failed against the old default with the exact evidence-limit exception and
  passes after the change. The existing explicit 1 KiB hostile-input test still
  proves fail-closed behavior.
- `INSTALL_CMD=true ./init.sh` passes harness review, root typecheck, 662 fast
  tests, and both production builds. `pnpm test:db:live` passes 171/171 live
  tests and 118/118 conformance checks. Publication and the production shadow
  build are the next actions.

## 2026-07-15 — Hierarchical folder priority regression

- A production outreach canary showed that Rackspace's real `\\Sent` folder could
  remain due while unrelated `INBOX.*` child folders consumed the bounded hot
  lane. The provider profile classified any path containing `inbox` as Inbox.
- Branch `fedster99/fix-rackspace-folder-priority` now treats only the exact
  Inbox role/path as priority 1, while preserving Sent as priority 5 and normal
  descendants as round-robin priority 100. The generic profile uses the same
  corrected semantics.
- Regression coverage lives in `provider-profiles.test.ts` for Rackspace and
  generic hierarchical paths. `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh` passed:
  typecheck, 655 fast tests, build, 158 live-DB tests, and 118 conformance checks.
  Commit/merge, immutable-image publication, and downstream production re-pin
  are the next actions.

Last updated: 2026-07-25

This is the tracked restart point for future agents. Keep it concise, factual, and safe to publish. Put private local notes, credentials, customer/provider probes, and one-off scratch work in `.context/` instead.

## Current Branch

- Active branch `fedster99/content-body-store-seam` implements ADR 0028's
  evidence-first content seam. The cloud image re-pin is deliberately deferred
  to a separate private-repo task.
- Active branch `fedster99/live-body-coverage-policy` makes
  `body_fetch_policy` mutable for existing accounts and replaces counter-derived
  live/priority body coverage with current-row evidence. ADR 0027 records the
  contract. This change adds one view-replacement migration and one partial
  live-body progress index.
- Active branch `fedster99/fix-reconcile-health-after-repair` separates observed reconcile gaps from unresolved reconcile state. A pass that fully tombstones provider-missing rows or backfills missing-in-DB UIDs now finishes clean and can return the account to `HEALTHY`; the run still records its bounded gap count. Missing-in-DB overflow is detected with a 5,001st sentinel row, remains degraded, and retries on the next full-sync cadence. ADR 0026 records the contract; no migration or public API change is required.
- Local branch `fedster99/smtp-account-lock-v2` is rebased onto current
  `origin/main` at `88c025d` and is intentionally uncommitted/unpushed. It closes
  the outbound-send serialization gap: `sendMessage` and `sendDraft` share the
  existing per-account advisory lock across their full provider sequence;
  contention throws `AccountBusyError` before delivery. Initial heartbeat
  persistence/session ownership is fail-closed, transient refresh errors retry,
  and long sends refresh below the stale-reaper threshold. Liveness is re-proven
  before SMTP; after confirmation, heartbeat/unlock/transport/appender teardown
  failures are warnings. False/error unlock evicts the pool client. No
  feature-list state changed because this is a maintainer-directed reliability
  repair, not a newly selected tracked feature.
- Active branch `fedster99/work-item-evidence` adds public migration `0016_message_evidence` and ADR 0025. Full MIME parsing now persists bounded decoded attachment SHA-256, calendar-instance, and strict provider-resource evidence without storing attachment bytes or making semantic cluster assignments. Evidence writes are atomic/versioned/idempotent; truncated fetches remain incomplete; existing body lanes backfill only missing extractor versions. Local live verification applies migrations twice, passes 152 live tests, and finishes all 118 spec-conformance checks.
- Active branch `fedster99/threading-long-lived-benchmark` adds one missing adversarial release-gate slice: an explicit RFC reply chain spanning 2020–2026 remains one conversation despite subject changes, while a new message that only reuses the old subject remains separate. This is benchmark-only; production threading logic is unchanged.
- Merged PR #72 adds ADR 0024's durable conversation projection. It separates physical mailbox rows, verified delivery copies, and RFC reply conversations; handles unresolved parents and orphan repair; and uses account-scoped provider hints plus a deliberately narrow subject fallback. Initial builds/upgrades/rebuilds are isolated, versioned shadow runs with bounded row/evidence/criteria work and per-run queues. Readers switch through one atomic active pointer only after coverage/catch-up checks and a persisted passing comparison for the exact generations/evidence revision; activation and latest incremental changes are auditable and reversible. A literal production executor registry plus startup/direct-path guards keeps rollback versions supported across a rollout, while a persisted three-active/one-standby/one-building schedule prevents sustained ingress from starving shadow or rollback work. Search/read APIs deduplicate delivery copies, while mailbox mutations still fan out to every physical UID. This is protocol threading only—there is no task/document/work-item, CRM, belief, or epistemic clustering layer.
- Current `main` includes PRs #69-#71's metadata batching and shutdown hardening. The threading branch preserves those bounded, generation-safe writes and adds two deadline-bounded state-barrier round trips before folder/message locks, keeping activation deadlock-free while retaining set-based batches. Large logical batches remain one transaction with bounded SQL payloads, FETCH retention, and projected flag writes.
- History metadata that finishes its IMAP fetch at the cooperative lock boundary persists under its own bounded database-write deadline, advances the watermark, and yields with `hitLockBudget` instead of becoming a repeated failure.
- ADR 0023 adds a bounded Sent freshness lane: Inbox remains first in full-sweep priority selection, while Sent receives a supplemental configurable metadata-only poll (`SENT_SYNC_INTERVAL_MS`, default 30 seconds) between 60-second full sweeps. The fast lane filters accounts without due Sent work before lock/connection/run creation, skips discovery/flags/reconcile/body/history, and leaves full-sweep health, backoff, `last_priority_sync_succeeded_at`, and `last_sync_finished_at` untouched. Its hard deadline is the next full sweep: an in-flight Sent connection is closed, further Sent accounts are deferred, and the worker rechecks Inbox-first work immediately without recording a false outage.
- Public migration `0013_body_head_trigram_index` adds a bounded 128 KiB body-text trigram expression index for exact substring consumers while ordinary language continues through body FTS. The migration is additive/idempotent and advances the public schema manifest to `0013_body_head_trigram_index`.
- PR #63 follows PR #62 by preserving sanitized error class, ordinary error code, and IMAP response status in persisted sync reasons. The worker emits `sync.account.failed` through `console.error` and `sync.account.partial_success` through `console.warn`, while retaining the aggregate `sync.tick.completed` info event.
- PR #64 makes API shutdown idempotent so a normal combined-mode rolling deploy does not emit a false `api.close.failed` / `ERR_SERVER_NOT_RUNNING`; genuine close errors remain structured error-level events.
- Integration branch is `main`. This branch is rebased onto `8c00bb7` (PR #70, full-sync shutdown cancellation), after PR #69 introduced batched metadata persistence; the GHCR core image republishes after CI succeeds on each `main` push.
- Recently merged: `#9` configurable `DATABASE_POOL_MAX`; `#10` reap orphaned `imap_sync_runs` on stale-lock recovery; `#12` nested mailbox-lock deadlock fix in history-backfill body fetch; `#13` live-DB proof of run reaping + `DATABASE_POOL_MAX` docs; `#15` reaper `started_at` race guard + reported reap counts; `#11` ADR 0014 (agent email access as a core read surface); `#17` UID-less FETCH guard; `#18` mirror Drafts folders; `#19` Drafts docs follow-up; `#20` historical-backfill acceptance coverage; `#21` issue #2 tracker update.
- Merged PR `#28` (2026-06-10, `73bc3e8`): adds `BODY_STORAGE_MODE=raw_mime|parsed_only` (default `raw_mime`, unchanged behavior) and public migration `0007_optional_raw_mime` making `imap_message_bodies.raw_mime` nullable. `parsed_only` fetches/parses bodies normally but stores NULL `raw_mime` (raw blobs dominate database size). Maintainer-directed from the hosted product's DB-size investigation; the engine stays single-tenant.
- Stale PR `#1` (`codex/oss-worker-core`) was closed as superseded by `#5`.
- Issue #2 historical backfill is now `passing` after fresh acceptance revalidation in `#20` and the tracker update in `#21`. Issue #3 provider compatibility, issue #4 MCP server, and issue #7 agent email CLI remain open and should not be treated as done.
- Active feature branch `fedster99/search-layer` (off `main`) adds the search layer (ADR 0015) — the shared read substrate behind issues #4 and #7. PR pending. Issue #7's CLI search command ships here; issue #4 still needs its MCP stdio transport binding around the included `search_email` tool contract.

## Current Shape

- Repo is a Turborepo monorepo.
- `apps/api` contains the SupaMail IMAP mirror API, worker, CLI, tests, scripts, Docker/Fly configs, and Supabase migration.
- `apps/web` contains the Next.js landing site.
- Root scripts delegate through Turborepo or `pnpm --filter @supamail/api`.
- `AGENTS.md` is the short routing layer. Detailed rules live in `docs/agent`, `docs/architecture`, deployment docs, README, and ADRs.
- `docs/hosted-product-boundary.md` documents what belongs outside the open-source core. The detailed hosted Supabase/Fly.io/Stripe/transactional-email runbook was moved to private `.context/production-setup.md`.
- Fly example configs now assume deployment from the repository root so Docker can use the monorepo as build context.
- Node runtime is pinned to Node 24 via package engines, `.node-version`, `.nvmrc`, CI, Docker, Fly examples, and the web package.
- Public mirror migrations now live under `apps/api/supabase/migrations/public/` with a manifest. `pnpm migrate`, CLI migration, and API `/migrate` apply public migrations only.
- Public migration `0014_conversation_threading` adds provider delivery/thread provenance, complete-MIME copy hashes, thread run/state/assignment projections, a database evidence clock/write-barrier, per-run protocol and subject work, an active view, comparison certificates, operations, and retention-safe history without mailbox-wide DML. The normal worker builds/drains bounded account work after sync passes and prunes old terminal projections; `threads-rebuild` remains shadow, `threads-compare` certifies a specific candidate, confirmed `threads-activate` cuts readers over, and confirmed `threads-rollback` pauses processing pending a clean rebuild.
- Public migration `0020_threading_fingerprint_closure` adds indexed, namespaced delivery-fingerprint hashes to the replaceable assignment projection. Bounded rebuild pages now close over shared raw/parsed/authored/exact-metadata evidence, preventing page-boundary false splits for mirrored automated messages with conflicting Message-ID evidence. Existing runs remain readable; a new shadow rebuild populates the evidence before comparison and activation.
- `SUPAMAIL_MODE=worker|api|combined` selects the public core runtime. Docker defaults to the runtime entrypoint, and `combined` is available for the later hosted Fly process.
- `apps/api/src/target-scheduler.ts` exposes the hosted multi-target scheduler contract: global cap, per-target cap default `1`, paused/stale target skips, failure isolation for async and sync target failures, and shutdown abort skips for work that has not started.
- Public docs now include hosted cloud contracts and v1 IMAP auth scope. V1 hosted billing is documented as `$5/month` BYO Supabase subscription with a 7-day no-card trial and Stripe customer portal; Managed remains private beta/manual approval.
- `.github/workflows/publish-core-image.yml` publishes the public core Docker image to GHCR after the CI workflow succeeds for a push to this repo's `main`; manual dispatch is restricted to the `main` ref.
- PR-1 of the reliability hardening sequence is implemented: `MAX_LOCK_HOLD_MS` is now enforced cooperatively at safe sync boundaries, `SyncResult.hitLockBudget` records budget hits, body backlog draining is capped by `MAX_BODY_BATCHES_PER_TICK`, and ADR 0008 documents the decision.
- PR-2 of the reliability hardening sequence is implemented: `INITIAL_SYNC_BATCH_TIMEOUT_MS` bounds initial sync snapshot/search/fetch work, aborts IMAP on timeout, treats the cycle as a transient failure, and preserves the initial-sync watermark for retry.
- PR-3 of the reliability hardening sequence is implemented: `imap_accounts.last_priority_sync_succeeded_at` records priority success, long-stuck `DEGRADED` accounts escalate to retryable `BROKEN` with `STUCK_DEGRADED_24H`, hourly retry uses `backoff_until`, seven-day terminal cutoff uses `STUCK_DEGRADED_TERMINAL`, and ADR 0009 documents the decision.
- PR-4 of the reliability hardening sequence is implemented: `FOLDER_COUNT_WARN_THRESHOLD` records `MANY_FOLDERS_PERFORMANCE_NOTE`, `FOLDER_COUNT_ENFORCE_THRESHOLD` tracks only priority folders and marks the account `DEGRADED` with `TOO_MANY_FOLDERS_REQUIRES_MANUAL_CONFIG`, `folder_count_cap_override` lets operators raise the enforce threshold, and `PENDING_VERIFICATION` is now a scheduler-excluded folder state that discovery can revive.
- PR-5 of the reliability hardening sequence is implemented: missing-mailbox errors are detected from structured IMAP response codes or fallback message patterns, affected folders move to `PENDING_VERIFICATION`, `next_folder_discovery_at` is forced to `now()`, `FOLDER_PENDING_VERIFICATION` events are logged, reappeared folders recover through discovery, and `POST /accounts/:id/folders/track` opts one existing non-provider-excluded folder back into sync past the folder-count cap.
- PR-6 of the reliability hardening sequence is implemented: `0004_account_lane_settings` adds `live_window_days`, `historical_backfill_mode`, `archive_refresh_interval`, `archive_flag_sync`, and `max_backfill_rate` to `imap_accounts` with defaults and CHECK constraints; account summaries expose the settings; `PATCH /accounts/:id/settings` updates `bodyFetchPolicy` plus the mutable historical/archive/backfill-rate settings and rejects `live_window_days` changes. PR-8 wires the historical/archive/backfill-rate settings into the engine.
- PR-7 of the reliability hardening sequence is implemented: `0005_progress_rollup` adds incremental folder progress counters and the `security_invoker` `imap_account_progress` view; `repository.upsertMessages`, `storeBody`, `setInitialSyncSnapshot`, and `handleUidValidityReset` maintain the counters; `GET /accounts/:id` returns account-level progress and per-folder progress rows. Migration `0021_row_accurate_body_progress` refines the view so current active message/body rows define live and priority body completeness, while cumulative counters remain telemetry. `estimated_full_sync_at` is exposed as nullable and remains null until a rate model exists.
- Issue #2 historical backfill is passing: `0006_history_lane_state` adds `imap_folders.last_archive_refresh_at`; `MirrorEngine.syncAccount` runs hot sync, capped live body fetch, then a history lane under the same account lock; `historical_backfill_mode`, `archive_refresh_interval`, `archive_flag_sync`, and `max_backfill_rate` are consumed by the engine; historical metadata and optional bodies use folder `backfill_*` state and roll into the PR-7 progress view. ADR 0012 documents the decision. PR #20 added acceptance coverage for multi-cycle batching/resume, idempotent re-walks, UIDVALIDITY reset during backfill, and default-settings backfill; PR #21 marked the tracker `passing`.
- Partial issue #3 provider compatibility work exists: `docs/imap-compatibility.md` defines the minimum IMAP capability contract, provider matrix, manual smoke checklist, and automated coverage split; provider profiles expose quirk metadata; the live DB gate includes deterministic Dovecot/cPanel-style and Cyrus/Rackspace-style fixture coverage plus empty LIST, large MIME body cap, fallback raw-body download cap, and transient disconnect checks. `pnpm smoke:greenmail` covers GreenMail's real IMAP/SMTP path, and `pnpm smoke:dovecot` covers Dovecot's real IMAP path with seeded Maildir folders. ADR 0013 documents the decision. Do not infer issue #3 completion from this without revalidating the GitHub acceptance criteria.
- `README.md` and `docs/agent/reliability-invariants.md` document the default sync edges: 90-day live window, 1-2 minute new-mail polling, 15-minute folder discovery, about 6-hour per-folder reconcile/delete detection, 7-day folder-missing grace, 10 priority and 5 round-robin folders per cycle, 100 live bodies per tick, 25 MB MIME cap, 10-minute lock budget, and 20-account default cap.
- Issue #7 tracks the future agent-first email CLI roadmap. It is intentionally separate from issue #4 MCP and should start read-oriented against the existing mirror with deterministic machine-readable output and clear sync trust signals.
- Ignored local env files were seeded for this workspace. Public handoff omits local project refs, generated tokens, API keys, and machine-specific env paths; see `.context/local-setup-handoff.md` when working in this workspace.
- A workspace Supabase project was created and `apps/api/supabase` is linked through ignored `.temp` files. Public handoff intentionally omits project identifiers; local setup details live in `.context/local-setup-handoff.md`.
- `DATABASE_POOL_MAX` (default 10) makes the Postgres pool size configurable per process; it does not change advisory-lock semantics, since each pooled connection is its own session. Documented in `.env.example`, `docs/deployment-options.md`, and `docs/agent/reliability-invariants.md`.
- Stale advisory-lock recovery (`clearOrphanedLocks` / `clearOrphanedLockForAccount`) now also closes the dead worker's open `imap_sync_runs` row as `failed` (reaped), guarded by an `r.started_at < now() - STALE_HEARTBEAT_MS` recency check so a freshly-started run is never mistaken for an orphan. `clearOrphanedLocks` returns `{ terminatedBackends, accountsReset, runsClosed }` and the worker logs them at startup so SIGKILL/OOM reaps are observable. Covered by live-DB tests in `apps/api/src/__tests__/sync-engine.live-db.test.ts`.
- `fetchFullMessageBody` takes `{ skipMailboxLock }`: the history-backfill snapshot body loop reuses the already-held mailbox selection (asserting it is the expected folder) instead of nesting a second `getMailboxLock`, which deadlocked on a live provider. Every other body-fetch caller still locks per message.
- ADR 0014 makes the MCP server (issue #4) and agent CLI (issue #7) a read-only core surface; see the Durable Decisions entry. The shared search read layer is now implemented (ADR 0015): `0008_search_layer.sql` (weighted FTS generated columns + pg_trgm + structured b-trees + self-gated pgvector hook), `apps/api/src/search/` (`searchMessages`, the query parser, the SQL compiler, the sync-trust block), the `supamail search` CLI command, and the `search_email` MCP tool contract (`searchEmailToolDefinition` / `runSearchTool`). On top of it: trigram-fuzzy + concept recall (typo+semantic, zero regression) and a trustworthy eval — frozen clock, graded relevance, significance A/B, junk-return guards. The MCP stdio server binding (issue #4 transport) and any further read commands for issue #7 are still pending.
- ADR 0015 records the search-layer design: two STORED generated tsvector columns (`imap_messages.header_fts` A/B/C, `imap_message_bodies.body_fts` D capped at 128KB), no trigger/queue, search driven off `imap_messages` with the body JOIN-only (no soft-delete leak), no raw email-array GINs (lowercased recipient matching), and a Tier-2 pgvector hook that no-ops unless `vector` is installed. The migration is additive/idempotent and proven by `pnpm test:db:live` (migration applied twice + `src/__tests__/search.live-db.test.ts`).
- The folder loop in `MirrorEngine.syncAccount` stops on a lost IMAP connection instead of cascading: when a per-folder error carries imapflow's `NoConnection`/`EConnectionClosed` code (`isConnectionLostError`), the engine records one summary error line, skips the body backlog and history lane for that pass, and defers to the next scheduled run. A dead connection no longer produces one `folder: Connection not available` line per remaining folder and no longer counts remaining priority folders as failures (which previously inflated `consecutive_failures` toward `BROKEN`). Diagnosed from hosted prod data: 225 of 228 affected runs were a single day on the pre-fix engine; the residual rate is ~0.05% of runs, always right after an `IMAP_COMMAND_TIMEOUT_MS` close, and self-heals on the next run.
- `BODY_STORAGE_MODE=raw_mime|parsed_only` (config enum, default `raw_mime`) controls raw blob retention: `parsed_only` stores NULL `raw_mime` while keeping parsed columns and `raw_bytes`/`raw_truncated` source metadata. Migration `0007_optional_raw_mime` drops the `raw_mime` NOT NULL; apply migrations before enabling `parsed_only`. Re-fetches while `parsed_only` is active also NULL previously stored blobs, and flipping back does not backfill them. Documented in README "Body Sync", `docs/schema.md`, and `.env.example`.

## Verification To Date

- Live-body policy and coverage (2026-07-23): the public API tracer test first
  failed because `PATCH /accounts/:id/settings` returned `400` for
  `bodyFetchPolicy`; it passed after the typed API/repository update. The old
  progress view also reported false 100 percent coverage in the new
  real-Postgres regression. `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh` passed:
  harness review, root typecheck, 685 fast tests, both production builds, 186
  live database tests including Scenarios R and S, and 118/118
  spec-conformance checks. `git diff --check` passed. The expected local Node 26
  engine warning appeared because the repository pins Node 24.
- Reconcile post-repair health fix (2026-07-14): the provider-delete regression first proved the old behavior by ending `DEGRADED` with `RECONCILE_GAPS_FOUND` despite a successful tombstone. The missing-in-DB overflow and early-retry regressions also failed before their implementations. After the fix, the focused live-DB slice passed all four repair/health tests. Under Node 24, `pnpm harness:check`, `pnpm typecheck`, `pnpm test` (636 fast tests), `pnpm build`, and `pnpm test:db:live` passed. The live gate preserved the populated migration fixture, applied migrations twice, passed all 155 live-DB tests, and passed 118/118 spec-conformance assertions.
- SMTP account-lock repair after rebasing onto current `origin/main` on
  2026-07-15: review hardening added draft/direct cross-contention, an explicit
  pre/post-SMTP liveness phase contract, transient refresh retry, full-lifetime
  heartbeat versus the real stale reaper, validated unlock with client eviction,
  graceful/fallback teardown lock coverage, and delivered-with-warning
  transport/appender close failures. The earlier pre-rebase gate passed the
  focused suite (123 tests), root typecheck, 633/633 fast tests, both production
  builds, `pnpm test:db:live` (16 files / 155 tests, including 6 real-session
  outbound lock tests), and 118/118 spec-conformance checks. After rebasing onto
  `88c025d`, the focused suite passed 125 tests and the full `./init.sh` gate
  passed typecheck, 653 fast tests, both builds, 158 live-Postgres tests (including
  all 6 outbound lock tests), and 118/118 spec-conformance checks.
- Long-lived threading benchmark (2026-07-14): the required-slice assertion failed first, then passed after adding the labeled multi-year chain and dangerous subject-reuse negative. `INSTALL_CMD=true ./init.sh` passed harness check, typecheck, 627 fast tests, and both production builds. `pnpm test:db:live` preserved the populated migration fixture, applied migrations twice, passed all 152 live-DB tests—including bounded incremental orphan resolution—and passed 118/118 spec-conformance assertions. Local Node 26 emitted the expected Node-24 engine and DEP0205 warnings.
- Threading production hardening (2026-07-14): `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh` passed the harness check, root typecheck, 625 fast tests, and both production builds before the live gate exposed a test-path mismatch around queue-empty 0014-ready coverage repair. The corrected regression explicitly exercises the scheduler-visible ready run through repair and final coverage certification. A fresh `pnpm test:db:live` then preserved a populated 5,000-row pre-0014 mirror, applied all public migrations twice, passed all 152 live-DB tests, and passed 118/118 spec-conformance assertions. Review additionally caught and fixed two rollout defects before release: old ready runs with empty queues were not scheduler-visible for coverage repair, and consecutive per-account catch-up steps could starve later accounts; focused worker tests now prove round-robin fairness. The local Node 26 shell emitted expected engine/deprecation warnings while CI remains pinned to Node 24.
- IMAP abort-race fix (2026-07-14): a focused regression first failed because emitting ImapFlow's late `Already logged out` error after an intentional pending-connect abort threw through EventEmitter; it passes after installing the runtime-client listener. A second red/green runtime regression proves combined API+worker mode enables the existing worker fatal-process handlers, and a third proves unrelated client errors remain observable without logging their message. Independent review then caught that the first combined-mode wiring could leave the API serving and exit successfully after a fatal event; a fourth red/green regression proves the owning runtime now shuts down with exit status 1. The final reviews caught the same ownership gap for SIGTERM/SIGINT during worker startup and the still-running startup work behind that close; the combined API close callback is now installed before worker startup checks, the lock-test retry budget is cancellation-aware, later maintenance phases short-circuit, and process listeners are removed at completion. The final `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh` passed the harness check, root typecheck, 623 fast tests, both builds, two idempotent migration applications, all 149 live-DB tests, and 118/118 spec-conformance checks; the final structured review returned no actionable regressions. The local Node 26 shell emitted the expected engine/deprecation warnings while CI remains pinned to Node 24.
- Conversation-threading documentation (2026-07-13): updated the public overview, schema, conformance matrix, reliability invariants, architecture map, search-eval semantics, and agent read guide for durable `conversation_id` / `delivery_key` behavior. `pnpm harness:check`, `git diff --check`, and a trailing-whitespace scan over touched docs passed; the local Node 26 shell emitted the expected warning because the repo pins Node 24. Full implementation verification is recorded separately when the code gate completes.
- Conversation-threading implementation after merging current `main` (2026-07-14): Node 24 typecheck passed; 616/616 fast tests passed; API and web production builds passed; the fresh PostgreSQL gate preserved a populated 5,000-row pre-0014 mirror, applied all migrations twice, passed 149/149 live tests, and passed 118/118 spec-conformance assertions. Focused overlap tests cover provider OBJECTID capture through the new bounded metadata batching path, the deadline-bounded threading state barrier, and worker scheduling on top of shutdown hardening.
- Full-sync shutdown cancellation (2026-07-14): the focused propagation regression failed before the fix and passed after it; `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh` passed harness, typecheck, 526 fast tests, both builds, and the initial live gate. After the ship coverage audit added body/history cancellation and health-invariance cases, `pnpm test:db:live` applied migrations twice, passed 109 live-DB tests (including real advisory-lock release), and passed 118/118 spec-conformance checks. The expected local Node 26 engine and DEP0205 warnings appeared; the repo and image pin Node 24.
- Batch-sync hardening (2026-07-14): after rebasing onto PR #70, the final `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh` passes the harness check, root typecheck, 549 fast tests, both builds, two idempotent migration applications, all 122 live-DB tests, and 118/118 spec-conformance checks. The shutdown-hardening regressions prove that aborting a metadata transaction blocked on a real row lock rolls back without counter drift, preserves account health, clears active state, and releases the account advisory lock before bounded cleanup; cleanup is fenced to the canceled run so it cannot clobber a newer owner, stale-lock reaping uses the same owner fence after backend termination, and an orphaned active-state projection becomes runnable immediately once the advisory lock is gone. Shutdown during provider-failure finalization still clears the owner projection and closes the durable sync run. Queued or pre-transaction aborted checkouts return clean clients to the pool instead of destroying them. Account/folder/history state writes are deadline-aware, and every history progress transition is guarded by the expected UIDVALIDITY generation. Flag payload chunks now remain inside one logical transaction and hooks run only after its commit, with focused success/rollback tests; PostgreSQL preflights the aggregate uncompressed stored-flag footprint before returning any arrays to Node for both projected and legacy callers, including a real-Postgres regression with a compressed value whose logical payload exceeds 8 MiB. A real-Postgres regression also proves that a failure in the second bounded metadata chunk rolls back messages, attachments, and counters written by the first. Other live regressions prove concurrent overlapping batches count unique UIDs once, the first write initializes a NULL folder generation, a queued UIDVALIDITY reset wins ahead of a stale-generation writer, folder-lock contention rolls back without counter drift, history hook failure leaves the watermark retryable, and an already-fetched history batch commits and advances its watermark after the cooperative budget expires. The first concurrency regression correctly failed with `headers_synced_count=4` for three unique rows, exposing that the prior combined folder/message lock query could retain a pre-wait statement snapshot; splitting lock acquisition from existing-UID inspection fixed it. Earlier final verification also passed under Node 24; the post-rebase run used local Node 26 and emitted the expected engine/deprecation warnings while CI remains pinned to Node 24.
- 10x sync-query work (2026-07-13): `pnpm harness:check`, root typecheck, 525 fast tests, root build, an earlier full `pnpm test:db:live` gate (migrations applied twice, 105 live tests, 118/118 conformance), focused real-Postgres flag/rollback telemetry regressions, and fresh public-core Docker builds passed. Focused regressions cover incomplete/duplicate/unexpected IMAP FETCH responses, unsafe sizes, deterministic UID order, 50-row query counts, all-or-nothing message/attachment/counter rollback, flag representation healing, unchanged-row stability, pool-acquisition and blocking-statement deadlines, and throughput behavior for post-commit hook failures and rolled-back batches. Cloud also passed its harness/typecheck/build, web/runtime suites, focused telemetry regressions, derivative image builds, public-export/orchestrator checks, and the same-platform pinned-core/candidate synthetic benchmark. The final stability-gated local run measured 479.95 versus 144.26 rows/s (3.33x ratio of medians; 3.23x paired-run median) with one full 50-message fake metadata batch; local amd64 emulation and best-case batching make it directional rather than production throughput. The candidate includes every public-core change since the production pin, so the speedup cannot be attributed solely to batching. Local shell verification used Node 26 despite the repo's Node 24 engine declaration; Docker verification used Node 24. A disposable non-BYPASSRLS Cloud overlay probe proved tenant isolation and rollback.
- Sent freshness lane (2026-07-12): red/green config, worker-cadence, live scheduling, and sync integration coverage; `pnpm test` passed 502 fast tests, `pnpm typecheck`, `pnpm build`, `git diff --check`, and `pnpm test:db:live` passed two idempotent migration applications, 98 live-DB tests, and 118/118 spec-conformance checks. The local Node 26 shell emitted the expected warning because the repo pins Node 24.
- Body-head trigram migration (2026-07-12): `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh` passed root typecheck, 498 fast tests, both builds, two idempotent public migration applications, 95 live-DB tests, and 118/118 spec-conformance checks. The local Node 26 shell emitted the expected warning because the repo pins Node 24.
- Structured failure logging (2026-07-11): focused red/green coverage for error detail retention and worker severity events passed; `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh` passed typecheck, 496 fast tests, both builds, 95 live-DB tests, and 118/118 spec-conformance checks. The first live run correctly exposed two stale exact-string assertions after class markers were added; both contracts were updated and the full gate then passed. Expected local Node 26, Next.js workspace-root, and Node DEP0205 warnings appeared.
- Idempotent API shutdown (2026-07-11): focused red/green runtime coverage and `INSTALL_CMD=true ./init.sh` passed typecheck, 498 fast tests, and both builds. Production evidence was the normal Render rollout after PR #63 emitting `api.close.failed` with `ERR_SERVER_NOT_RUNNING`; the fix suppresses only that already-closed condition and still tests genuine teardown-error logging.
- Body storage mode (2026-06-10): `pnpm typecheck`, `pnpm test` (149 unit tests incl. new config/schema/repository-safety coverage), `pnpm test:db:live` twice (38 integration tests incl. a new parsed_only end-to-end fixture sync proving NULL `raw_mime` + intact parsed text, full migration set applied repeatedly for idempotency, 118 spec-conformance scenario checks), and `INSTALL_CMD=true ./init.sh` all passed under the local Node 26 shell (expected engine warnings; repo pins Node 24).
- `./init.sh` passed after adding the docs / harness impact reminder.
- `pnpm harness:check` prints the pre-git docs / harness reminder.
- `node --check scripts/check-harness-impact.mjs` passed.
- `git diff --check` and `git diff --cached --check` passed before commit `78767e0`.
- CI after push passed `Quality` and `Live DB Reliability`.
- Root handoff migration verification: `INSTALL_CMD=true ./init.sh`, `pnpm harness:check`, `git diff --check`, and a trailing-whitespace scan over the touched docs/scripts passed.
- Production setup runbook / Fly config verification before private move: `pnpm harness:check`, `git diff --check`, `rg -n "[ \t]+$" docs/production-setup.md` (no matches; `rg` exited 1), `pnpm --filter @supamail/api test -- deployment-config`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `fly config validate --config apps/api/fly.worker.toml.example`, and `fly config validate --config apps/api/fly.api.toml.example` passed. Older root checks emitted Node engine warnings because the shell was on Node v26 while the repo expected a different LTS major.
- Local env verification: `git check-ignore` confirmed local env files are ignored; file modes were set to `600`; `pnpm --filter @supamail/api exec tsx -e ...` confirmed required API config loads. Local file paths and setup notes live in `.context/local-setup-handoff.md`.
- Supabase project setup verification: workspace project reached healthy state; API keys were pulled into ignored env files; SupaMail migration applied with `pnpm migrate`; migration history recorded `0001`; table query found 7 mirror tables; Supabase advisors reported no issues; `runLockSelfTest` passed against the session pooler.
- Post-setup verification: `pnpm --filter @supamail/api exec vitest run src/__tests__/db.test.ts`, `pnpm --filter @supamail/api typecheck`, `pnpm --filter @supamail/api build`, `pnpm --filter @supamail/api test`, `pnpm harness:check`, `git diff --check`, `pnpm typecheck`, `pnpm build`, `pnpm test:db:live`, and `pnpm test` passed. The local shell may still warn while it runs Node v26 instead of the pinned LTS.
- Hosted boundary cleanup verification: moved the detailed hosted runbook to `.context/production-setup.md`, added `docs/hosted-product-boundary.md`, removed hosted Stripe/SMTP placeholders from tracked `.env.example`, and ran `pnpm --filter @supamail/api exec vitest run src/__tests__/deployment-config.test.ts`, `git diff --check`, and a trailing-whitespace scan on the touched public env/boundary docs. The trailing-whitespace scan had no matches, so `rg` exited 1.
- Hosted architecture note update: private `.context/production-setup.md` was revised for the initial hosted Fly/Vercel split; `git diff --check` and a trailing-whitespace scan on the touched files passed. No code verification was needed.
- Public core hosted-prereq verification: `pnpm --filter @supamail/api exec vitest run src/__tests__/schema.test.ts src/__tests__/deployment-config.test.ts src/__tests__/target-scheduler.test.ts src/__tests__/runtime.test.ts src/__tests__/repository-safety.test.ts`, `pnpm --filter @supamail/api typecheck`, `pnpm --filter @supamail/api build`, compiled runtime checks for worker/API/combined, `pnpm --filter @supamail/api test`, `pnpm harness:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:db:live`, local `docker build -f apps/api/Dockerfile -t supamail-api:local-contract .`, Docker runtime checks for worker/API/combined, `fly config validate --config apps/api/fly.worker.toml.example`, `fly config validate --config apps/api/fly.api.toml.example`, `npm pack --dry-run --json` from `apps/api`, `git diff --check`, and a trailing-whitespace scan passed.
- Review fix verification: `pnpm --filter @supamail/api exec vitest run src/__tests__/target-scheduler.test.ts src/__tests__/deployment-config.test.ts`, `pnpm --filter @supamail/api typecheck`, `pnpm --filter @supamail/api test`, `pnpm typecheck`, `pnpm harness:check`, and `git diff --check` passed. `actionlint` was not installed, so workflow syntax was reviewed by inspection and covered by deployment-config string checks.
- Handoff hygiene verification: split local Supabase/env setup details into ignored `.context/local-setup-handoff.md`, refreshed `.context/harness-assessment.md`, confirmed tracked docs no longer contain the workspace Supabase ref, ran `git diff --check`, a trailing-whitespace scan on touched handoff docs, `git check-ignore` for the `.context` handoff files, and `pnpm harness:check`. The expected Node v26 warning appeared.
- Node 24 upgrade verification: with `npx -y -p node@24 -p pnpm@10.0.0`, `pnpm install --frozen-lockfile`, `pnpm --filter @supamail/api exec vitest run src/__tests__/deployment-config.test.ts`, `pnpm harness:check`, `pnpm typecheck`, `pnpm test`, and `pnpm build` passed. `docker pull node:24-slim` passed after the first build attempt stalled during the base-image pull; retrying `docker build -f apps/api/Dockerfile -t supamail-api:node24-contract .` passed. Docker runtime checks for `worker`, `api`, and `combined` passed with `SUPAMAIL_RUNTIME_CHECK=1`. `fly config validate --config apps/api/fly.worker.toml.example`, `fly config validate --config apps/api/fly.api.toml.example`, and `git diff --check` passed.
- Reliability PR-1 verification: `pnpm --filter @supamail/api typecheck`, `pnpm --filter @supamail/api exec vitest run src/__tests__/api-safety.test.ts src/__tests__/repository-safety.test.ts`, `pnpm --filter @supamail/api exec vitest run src/__tests__/sync-engine.integration.test.ts`, `pnpm --filter @supamail/api test`, `git diff --check`, trailing-whitespace scan on `docs/architecture/decisions/0008-cooperative-account-lock-budget.md`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm harness:check`, and `pnpm test:db:live` passed. The expected Node v26 engine warnings and Node DEP0205 warnings appeared.
- OSS web page rewrite verification on 2026-05-23: commit `bc2fbcf` simplified the public web app into a compact OSS/docs page. `npx -y -p node@24 -p pnpm@10.0.0 pnpm --filter @supamail/web typecheck`, `npx -y -p node@24 -p pnpm@10.0.0 pnpm --filter @supamail/web test`, `npx -y -p node@24 -p pnpm@10.0.0 pnpm --filter @supamail/web build`, `npx -y -p node@24 -p pnpm@10.0.0 pnpm harness:check`, `npx -y -p node@24 -p pnpm@10.0.0 pnpm typecheck`, `npx -y -p node@24 -p pnpm@10.0.0 pnpm test`, `npx -y -p node@24 -p pnpm@10.0.0 pnpm build`, and `git diff --check` passed. Local dev render at `http://localhost:3001` passed desktop and mobile screenshot smoke; screenshots are ignored in `.context/`. PR #5 checks after push passed `Quality`, `Live DB Reliability`, `Vercel`, and `Vercel Preview Comments`. Turbo replayed older cached API logs that contained the known local Node v26 engine warning; GitHub CI still emits the Node 20 action deprecation annotation until the public workflow action versions are upgraded.
- Public CI action runtime cleanup on 2026-05-24: upgraded `actions/checkout`, `actions/setup-node`, and `pnpm/action-setup` from `v4` to `v6`; upgraded `docker/login-action` from `v3` to `v4` in the GHCR publish workflow. Each upgraded action declares `node24` in `action.yml`.
- Reliability PR-2 verification on 2026-05-24: `pnpm --filter @supamail/api exec vitest run src/__tests__/sync-engine.integration.test.ts --testNamePattern "Scenario H"`, `pnpm --filter @supamail/api exec vitest run src/__tests__/sync-engine.integration.test.ts`, `pnpm --filter @supamail/api typecheck`, `pnpm --filter @supamail/api spec-conformance`, and `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh` passed. The expected local Node v26 engine warnings and Node DEP0205 warnings appeared.
- Reliability PR-3 verification on 2026-05-24: `pnpm --filter @supamail/api exec vitest run src/__tests__/sync-engine.integration.test.ts --testNamePattern "Scenario I"`, `pnpm --filter @supamail/api exec vitest run src/__tests__/repository-safety.test.ts src/__tests__/schema.test.ts src/__tests__/target-scheduler.test.ts`, `pnpm --filter @supamail/api typecheck`, `pnpm --filter @supamail/api spec-conformance`, `pnpm --filter @supamail/api exec vitest run src/__tests__/sync-engine.integration.test.ts`, and `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh` passed. The live gate applied public migrations twice, ran live DB integration, and finished spec conformance with 67 passes. The expected local Node v26 engine warnings and Node DEP0205 warnings appeared.
- Reliability PR-4 verification on 2026-05-24: `pnpm --filter @supamail/api typecheck`, `pnpm --filter @supamail/api exec vitest run src/__tests__/sync-engine.integration.test.ts --testNamePattern "Scenario J"`, `pnpm --filter @supamail/api exec vitest run src/__tests__/repository-safety.test.ts src/__tests__/schema.test.ts src/__tests__/target-scheduler.test.ts src/__tests__/api-safety.test.ts`, `pnpm --filter @supamail/api spec-conformance`, and `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh` passed. The live gate applied public migrations twice, ran live DB integration, and finished spec conformance with 84 passes. The expected local Node v26 engine warnings and Node DEP0205 warnings appeared.
- Reliability PR-5 verification on 2026-05-24: `pnpm --filter @supamail/api typecheck`, `pnpm --filter @supamail/api exec vitest run src/__tests__/api-safety.test.ts src/__tests__/repository-safety.test.ts src/__tests__/sync-engine-safety.test.ts`, `pnpm --filter @supamail/api exec vitest run src/__tests__/sync-engine.integration.test.ts --testNamePattern "Scenario (J|K)"`, `pnpm --filter @supamail/api spec-conformance`, and `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh` passed. The live gate applied public migrations twice, ran live DB integration, and finished spec conformance with 103 passes. The expected local Node v26 engine warnings and Node DEP0205 warnings appeared.
- Reliability PR-6 verification on 2026-05-24: `pnpm --filter @supamail/api exec vitest run src/__tests__/api-safety.test.ts src/__tests__/schema.test.ts src/__tests__/repository-safety.test.ts src/__tests__/target-scheduler.test.ts`, `pnpm --filter @supamail/api typecheck`, `pnpm --filter @supamail/api spec-conformance`, `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh`, `git diff --check`, and a trailing-whitespace scan over touched files passed. The live gate applied public migrations twice, ran live DB integration, and finished spec conformance with 103 passes. The expected local Node v26 engine warnings and Node DEP0205 warnings appeared.
- Reliability PR-7 verification on 2026-05-24: `pnpm --filter @supamail/api typecheck`, `pnpm --filter @supamail/api exec vitest run src/__tests__/api-safety.test.ts src/__tests__/schema.test.ts src/__tests__/repository-safety.test.ts src/__tests__/target-scheduler.test.ts`, `pnpm --filter @supamail/api exec vitest run src/__tests__/sync-engine.integration.test.ts --testNamePattern "Scenario M"`, `pnpm --filter @supamail/api spec-conformance`, `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh`, `pnpm harness:check`, `git diff --check`, and a trailing-whitespace scan over touched files passed. The live gate applied public migrations twice, ran live DB integration, and finished spec conformance with 112 passes. The expected local Node v26 engine warnings and Node DEP0205 warnings appeared.
- Reliability PR-8 verification on 2026-05-24: `pnpm --filter @supamail/api typecheck`, `pnpm --filter @supamail/api exec vitest run src/__tests__/schema.test.ts src/__tests__/repository-safety.test.ts src/__tests__/sync-engine-safety.test.ts src/__tests__/target-scheduler.test.ts`, `pnpm --filter @supamail/api exec vitest run src/__tests__/sync-engine.integration.test.ts --testNamePattern "Scenario L"`, `pnpm --filter @supamail/api exec vitest run src/__tests__/sync-engine.integration.test.ts --testNamePattern "Scenario (L|M)"`, `pnpm --filter @supamail/api spec-conformance`, and `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh` passed. The full gate ran root typecheck/test/build, applied public migrations twice against disposable Postgres, ran live DB integration with 25 tests passed, and finished spec conformance with 118 passes. The expected local Node v26 engine warnings and Node DEP0205 warnings appeared.
- Issue #3 provider compatibility verification on 2026-05-24: `pnpm --filter @supamail/api typecheck`, `pnpm --filter @supamail/api exec vitest run src/__tests__/provider-profiles.test.ts src/__tests__/imap-client.test.ts`, `pnpm --filter @supamail/api test:db:live`, `pnpm --filter @supamail/api smoke:greenmail`, `pnpm --filter @supamail/api smoke:dovecot`, and `INSTALL_CMD=true RUN_LIVE_DB=1 ./init.sh` passed. A follow-up review fix added dot-delimiter All Mail coverage and fallback raw MIME download cap coverage; the final live DB gate ran provider compatibility, sync-engine integration, live DB integration, and spec conformance with 31 live integration tests and 118 spec checks passed. The GreenMail smoke mirrored 3 messages, 3 bodies, 1 attachment, and 0 false provider deletes. The Dovecot smoke mirrored 4 non-excluded messages, 4 bodies, 1 attachment, kept Archive tracked, excluded Trash, and recorded 0 false provider deletes. The expected local Node v26 engine warnings and Node DEP0205 warnings appeared.
- Issue #7 roadmap update on 2026-05-28: created https://github.com/fedster99/supamail/issues/7 and added it to `docs/agent/feature-list.json` as `not_started`. Verified with `jq . docs/agent/feature-list.json >/dev/null`, `pnpm harness:check`, `git diff --check`, and a trailing-whitespace scan over the touched files. The trailing-whitespace scan had no matches, so `rg` exited 1. The expected local Node v26 engine warning appeared during `pnpm harness:check`.
- Issue #2/#3 tracker correction on 2026-05-29: maintainer clarified that both issues are not done. Updated `docs/agent/feature-list.json` to mark both as `not_started` with notes requiring future revalidation against GitHub acceptance criteria before any `passing` state.
- Default sync edges documentation on 2026-05-29: added a concise public section to `README.md` and an agent-facing default edge list to `docs/agent/reliability-invariants.md`. Verification was docs-only: `pnpm harness:check`, `git diff --check`, and a trailing-whitespace scan over touched docs.
- Agent-access charter decision on 2026-06-04: recorded ADR 0014 establishing the MCP server (#4) and agent CLI (#7) as a read-only core surface that cloud only hosts (core builds the artifact and read-tool contract; cloud adds remote transport and auth). Amended the durable scope decision, added the ADR to the decisions index, and tightened the `feature-list.json` notes for #4/#7. No code changed; the MCP/CLI implementation remains a separately selected future task. Verification was docs-only: `jq . docs/agent/feature-list.json`, `pnpm harness:check`, `git diff --check`, and a trailing-whitespace scan over touched files. Merged as `#11`.
- Reaper conformance + hardening on 2026-06-04: `#13` added the missing live-DB proof that stale-lock recovery closes orphaned `imap_sync_runs`, plus `DATABASE_POOL_MAX` docs and review-driven test hardening (run files sequentially in the live gate via `--no-file-parallelism`, and a live-account-untouched assertion). `#15` added the `started_at` race guard and the reaped-count reporting. Both verified red/green (the new tests fail against the pre-fix code) and with `pnpm test:db:live` (118 spec passes, 10 live-DB tests). `#9` configurable pool size, `#10` orphaned-run reaping, and `#12` history-backfill body-fetch deadlock fix also landed on `main`. Each merge passed CI (`Quality`, `Live DB Reliability`) and republished the GHCR core image.
- Issue #2 historical backfill completion on 2026-06-05: PR #20 revalidated all seven acceptance criteria and added integration scenarios N-Q for multi-cycle batching/resume, idempotent re-walks, UIDVALIDITY reset during backfill, and default-settings backfill. Verified with `pnpm test:db:live` (118 spec passes, 4 new scenarios green), `pnpm typecheck`, `pnpm test`, and `pnpm build`. PR #21 marked `docs/agent/feature-list.json` `issue-2-historical-backfill` as `passing`.

## Durable Decisions

- SupaMail core owns email sync only. Do not add CRM identity hydration, person/company resolution, handle mapping, Signal dashboard code, Trigger.dev coupling, AI features, calendar, contacts, sending, or scheduling unless the selected task explicitly asks for it.
- Agent email access is an explicit exception, scoped by ADR 0014: the MCP server (issue #4) and agent-first CLI (issue #7) are built in the public core as a read-only surface. Build location is not run location. Core owns the MCP server implementation, the read-tool contract, the CLI commands and their deterministic output, the local stdio binding, and the read-only boundary; cloud owns only the remote transport, bearer/tenant auth, and MCP token secrets. The seam is transport and auth, not tool logic. These two issues stay in this repo and must not be stripped from core citing ADR 0001. V1 stays read-only; sending, scheduling, contacts, calendar, CRM hydration, and AI summarization stay out unless a later ADR adds them.
- Message identity means mailbox-row identity: `(account_id, folder_path, uidvalidity, uid)`.
- Delivery-copy identity and conversation identity are derived, account-scoped `delivery_key` / `conversation_id` assignments, not replacements for mailbox-row identity. RFC reply edges outrank provider hints; unresolved parent IDs remain provisional; conservative subject matching is disabled for incomplete incremental universes. Conversation threading must remain separate from semantic work-item or epistemic clustering.
- Session-affine Postgres is required for advisory locks.
- `MAX_LOCK_HOLD_MS` is a cooperative account-lock fairness budget: priority folders may complete past the deadline, non-priority/body work stops at safe boundaries, and budget-hit cycles are neutral for backoff counters.
- Reconcile health describes the post-repair mirror, not whether drift was observed before the pass. `reconcile_gaps_found` preserves bounded observation telemetry; fully repaired drift is clean, while overflowed, interrupted, or incomplete repair remains degraded and retries on the next full-sync cadence.
- Stuck-degraded escalation is driven by `imap_accounts.last_priority_sync_succeeded_at`: priority success refreshes it, retryable `STUCK_DEGRADED_24H` probes hourly without compounding exponential backoff, and `STUCK_DEGRADED_TERMINAL` stops automatic scheduling until operator action.
- Folder-count caps warn first, then enforce by tracking only priority folders; the cap uses the latest provider LIST count so provider-side pruning recovers automatically.
- `PENDING_VERIFICATION` is reserved for missing-mailbox verification and is excluded from normal folder scheduling; missing-mailbox errors force near-term folder discovery.
- Per-account historical-backfill lane settings are typed columns on `imap_accounts`; `live_window_days` is immutable after account creation in v0.1, and the history lane consumes the mutable historical/archive/backfill-rate settings.
- Existing accounts may change `body_fetch_policy` through `PATCH /accounts/:id/settings`. `priority_then_backfill` covers current priority folders only; it does not defer current non-priority bodies to the history lane.
- Progress counters are maintained on `imap_folders` in the same write paths as header/body state and remain cumulative telemetry. `imap_account_progress` derives live and priority body coverage from current active `IN_WINDOW` messages and complete, non-truncated body rows; `GET /accounts/:id` is the API surface for downstream completeness checks.
- The history lane is the third phase under the same account lock, after hot sync and the capped live body lane. It snapshots older-than-window UIDs per folder, walks newest-first through `backfill_*` watermarks, and stops when the cooperative lock budget or `max_backfill_rate` says to stop. History progress does not determine account health.
- Generic IMAP support means a minimum protocol contract validated by provider shape and recorded in the compatibility matrix. Provider-specific quirks must stay in provider profiles or profile-driven hooks, not scattered sync-engine conditionals.
- Hosted cloud must consume a pinned public core image digest/SHA and apply only public mirror migrations to customer BYO databases.
- Supabase OAuth refresh tokens and generated DB passwords must be encrypted before storage; plaintext secrets must not live in the control-plane DB, logs, tracked env examples, or PRs.
- V1 IMAP auth is username/password or provider app-password only. Gmail OAuth and Microsoft OAuth are deferred.
- Stripe webhook fulfillment belongs in the private Vercel app as a Node runtime route that durably stores a unique Stripe event and queues Fly-side fulfillment before returning `200`.
- Live DB reliability work must run `pnpm test:db:live`.
- Before committing, pushing, or updating a PR, run `./init.sh`. If bypassing it, run `pnpm harness:check` before `git commit` or `gh pr edit` and record the exception.

## Open Risks

- The merged PR #69 image should not be widened until this follow-up hardening is reviewed, merged, and published as a new immutable image. Historical-backfill UID enumeration remains quadratic across batches and is intentionally deferred to a separate cursor-semantics change with sparse-UID, expunge, crash, and resume coverage.
- Private `supamail-cloud` now has Supabase Auth, live Stripe billing, Managed Hosting provisioning/mailbox connect, and the stage-one Fly runtime live/passing. BYO Supabase onboarding and the full paid hosted smoke remain future hosted tasks.
- `supamail-cloud` currently pins this repo at `7f1d181df89b7d86168bc6136da3f400d6fa8239`; after this fix lands and its immutable GHCR image publishes, Cloud must re-pin the source SHA, tag, digest, and Docker `FROM` together.
- The public `apps/web` page is now a compact OSS/docs page. Keep richer hosted signup and SaaS copy in `supamail-cloud`.

## Next Best Actions

- Review and land the feature-branch PR for
  `fedster99/live-body-coverage-policy`. Publish a new immutable public-core
  image only after human merge, then update downstream Signal through its
  public-core prebuild and re-pin flow.
- Review and land `fedster99/fix-reconcile-health-after-repair`, publish its immutable image, then re-pin downstream consumers. Confirm ordinary provider delete/move drift records a nonzero gap count without leaving a fully repaired account stuck `DEGRADED`.
- Review and land `fedster99/fix-imap-abort-race`, publish its immutable image, then re-pin downstream consumers and canary the Sent/full-sweep deadline boundary. Confirm there are no further `Already logged out`, `process.uncaughtException`, or Render restart events.
- Keep this file updated at the end of substantial sessions.
- If a session includes private provider/customer details, summarize only safe facts here and keep private detail in `.context/`.
- When repo layout, scripts, CI, deploy config, schema paths, startup flow, task boundaries, or verification lanes change, update the relevant docs and note the docs / harness decision in the PR body.
- GitHub issue #3 remains open until its new Dovecot CI gate lands.
  Issues #4 (MCP) and #7 (agent CLI) were revalidated as implemented on
  2026-07-23 and should remain closed. Their core/cloud boundary is still
  governed by ADR 0014.
- Next hosted setup step lives in private `supamail-cloud`: BYO Supabase onboarding (`cloud-004`) is the next selectable hosted feature, followed by the full paid hosted smoke (`cloud-005`).
