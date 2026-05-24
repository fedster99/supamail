# Session Handoff

Last updated: 2026-05-24

This is the tracked restart point for future agents. Keep it concise, factual, and safe to publish. Put private local notes, credentials, customer/provider probes, and one-off scratch work in `.context/` instead.

## Current Branch

- Branch: `fedster99/supamail-v0.1`
- PR: https://github.com/fedster99/supamail/pull/5
- Harness reminder baseline: `78767e0 Add harness impact reminder`
- Root handoff migration: `912989a Move session handoff to repo root`
- Last pushed reliability PR-3 handoff commit: `847c6d5 Refresh PR-3 handoff status`.
- PR checks after `847c6d5`: `Quality`, `Live DB Reliability`, `Vercel`, and `Vercel Preview Comments` passed.
- Reliability PR-4 folder-count cap plus `PENDING_VERIFICATION` schema/scheduler support is implemented in the current local changes; recheck PR status after commit/push.

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
- `SUPAMAIL_MODE=worker|api|combined` selects the public core runtime. Docker defaults to the runtime entrypoint, and `combined` is available for the later hosted Fly process.
- `apps/api/src/target-scheduler.ts` exposes the hosted multi-target scheduler contract: global cap, per-target cap default `1`, paused/stale target skips, failure isolation for async and sync target failures, and shutdown abort skips for work that has not started.
- Public docs now include hosted cloud contracts and v1 IMAP auth scope. V1 hosted billing is documented as `$5/month` BYO Supabase subscription with a 7-day no-card trial and Stripe customer portal; Managed remains private beta/manual approval.
- `.github/workflows/publish-core-image.yml` publishes the public core Docker image to GHCR after the CI workflow succeeds for a push to this repo's `main`; manual dispatch is restricted to the `main` ref.
- PR-1 of the reliability hardening sequence is implemented: `MAX_LOCK_HOLD_MS` is now enforced cooperatively at safe sync boundaries, `SyncResult.hitLockBudget` records budget hits, body backlog draining is capped by `MAX_BODY_BATCHES_PER_TICK`, and ADR 0008 documents the decision.
- PR-2 of the reliability hardening sequence is implemented: `INITIAL_SYNC_BATCH_TIMEOUT_MS` bounds initial sync snapshot/search/fetch work, aborts IMAP on timeout, treats the cycle as a transient failure, and preserves the initial-sync watermark for retry.
- PR-3 of the reliability hardening sequence is implemented: `imap_accounts.last_priority_sync_succeeded_at` records priority success, long-stuck `DEGRADED` accounts escalate to retryable `BROKEN` with `STUCK_DEGRADED_24H`, hourly retry uses `backoff_until`, seven-day terminal cutoff uses `STUCK_DEGRADED_TERMINAL`, and ADR 0009 documents the decision.
- PR-4 of the reliability hardening sequence is implemented locally: `FOLDER_COUNT_WARN_THRESHOLD` records `MANY_FOLDERS_PERFORMANCE_NOTE`, `FOLDER_COUNT_ENFORCE_THRESHOLD` tracks only priority folders and marks the account `DEGRADED` with `TOO_MANY_FOLDERS_REQUIRES_MANUAL_CONFIG`, `folder_count_cap_override` lets operators raise the enforce threshold, and `PENDING_VERIFICATION` is now a scheduler-excluded folder state that discovery can revive.
- Ignored local env files were seeded for this workspace. Public handoff omits local project refs, generated tokens, API keys, and machine-specific env paths; see `.context/local-setup-handoff.md` when working in this workspace.
- A workspace Supabase project was created and `apps/api/supabase` is linked through ignored `.temp` files. Public handoff intentionally omits project identifiers; local setup details live in `.context/local-setup-handoff.md`.

## Verification To Date

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

## Durable Decisions

- SupaMail core owns email sync only. Do not add CRM identity hydration, person/company resolution, handle mapping, Signal dashboard code, Trigger.dev coupling, AI features, MCP, calendar, contacts, sending, or scheduling unless the selected task explicitly asks for it.
- Message identity means mailbox-row identity: `(account_id, folder_path, uidvalidity, uid)`.
- Session-affine Postgres is required for advisory locks.
- `MAX_LOCK_HOLD_MS` is a cooperative account-lock fairness budget: priority folders may complete past the deadline, non-priority/body work stops at safe boundaries, and budget-hit cycles are neutral for backoff counters.
- Stuck-degraded escalation is driven by `imap_accounts.last_priority_sync_succeeded_at`: priority success refreshes it, retryable `STUCK_DEGRADED_24H` probes hourly without compounding exponential backoff, and `STUCK_DEGRADED_TERMINAL` stops automatic scheduling until operator action.
- Folder-count caps warn first, then enforce by tracking only priority folders; the cap uses the latest provider LIST count so provider-side pruning recovers automatically.
- `PENDING_VERIFICATION` is reserved for missing-mailbox verification and is excluded from normal folder scheduling.
- Hosted cloud must consume a pinned public core image digest/SHA and apply only public mirror migrations to customer BYO databases.
- Supabase OAuth refresh tokens and generated DB passwords must be encrypted before storage; plaintext secrets must not live in the control-plane DB, logs, tracked env examples, or PRs.
- V1 IMAP auth is username/password or provider app-password only. Gmail OAuth and Microsoft OAuth are deferred.
- Stripe webhook fulfillment belongs in the private Vercel app as a Node runtime route that durably stores a unique Stripe event and queues Fly-side fulfillment before returning `200`.
- Live DB reliability work must run `pnpm test:db:live`.
- Before committing, pushing, or updating a PR, run `./init.sh`. If bypassing it, run `pnpm harness:check` before `git commit` or `gh pr edit` and record the exception.

## Open Risks

- Reactive rediscovery on missing-mailbox errors remains an open delta in `docs/spec-conformance.md`; PR-4 only added the `PENDING_VERIFICATION` state and scheduler support.
- Private `supamail-cloud` repo/app creation and first Vercel web deploy are done outside this public workspace. Supabase Auth setup, Stripe product/webhook setup, Supabase OAuth BYO onboarding, and hosted Fly deploy are still pending there.
- The public `apps/web` page is now a compact OSS/docs page. Keep richer hosted signup and SaaS copy in `supamail-cloud`.

## Next Best Actions

- Keep this file updated at the end of substantial sessions.
- If a session includes private provider/customer details, summarize only safe facts here and keep private detail in `.context/`.
- When repo layout, scripts, CI, deploy config, schema paths, startup flow, task boundaries, or verification lanes change, update the relevant docs and note the docs / harness decision in the PR body.
- Next reliability hardening slice: PR-5 reactive rediscovery with missing-mailbox detection, `PENDING_VERIFICATION` transitions, forced discovery, and folder opt-in endpoint, per `docs/architecture/reliability-and-three-lanes.md`.
- Next hosted setup step: continue in private `supamail-cloud` with Supabase Auth + Stripe Checkout/webhook using the public contracts in `docs/hosted-cloud-contracts.md`.
