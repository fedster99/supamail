# Session Handoff

Last updated: 2026-05-20

This is the tracked restart point for future agents. Keep it concise, factual, and safe to publish. Put private local notes, credentials, customer/provider probes, and one-off scratch work in `.context/` instead.

## Current Branch

- Branch: `fedster99/supamail-v0.1`
- PR: https://github.com/fedster99/supamail/pull/5
- Harness reminder baseline: `78767e0 Add harness impact reminder`
- Root handoff migration: `912989a Move session handoff to repo root`
- PR checks after `78767e0`: `Quality`, `Live DB Reliability`, `Vercel`, and `Vercel Preview Comments` passed. Recheck PR status after newer pushes.

## Current Shape

- Repo is a Turborepo monorepo.
- `apps/api` contains the SupaMail IMAP mirror API, worker, CLI, tests, scripts, Docker/Fly configs, and Supabase migration.
- `apps/web` contains the Next.js landing site.
- Root scripts delegate through Turborepo or `pnpm --filter @supamail/api`.
- `AGENTS.md` is the short routing layer. Detailed rules live in `docs/agent`, `docs/architecture`, deployment docs, README, and ADRs.

## Verification To Date

- `./init.sh` passed after adding the docs / harness impact reminder.
- `pnpm harness:check` prints the pre-git docs / harness reminder.
- `node --check scripts/check-harness-impact.mjs` passed.
- `git diff --check` and `git diff --cached --check` passed before commit `78767e0`.
- CI after push passed `Quality` and `Live DB Reliability`.
- Root handoff migration verification: `INSTALL_CMD=true ./init.sh`, `pnpm harness:check`, `git diff --check`, and a trailing-whitespace scan over the touched docs/scripts passed.

## Durable Decisions

- SupaMail core owns email sync only. Do not add CRM identity hydration, person/company resolution, handle mapping, Signal dashboard code, Trigger.dev coupling, AI features, MCP, calendar, contacts, sending, or scheduling unless the selected task explicitly asks for it.
- Message identity means mailbox-row identity: `(account_id, folder_path, uidvalidity, uid)`.
- Session-affine Postgres is required for advisory locks.
- Live DB reliability work must run `pnpm test:db:live`.
- Before committing, pushing, or updating a PR, run `./init.sh`. If bypassing it, run `pnpm harness:check` before `git commit` or `gh pr edit` and record the exception.

## Open Risks

- `MAX_LOCK_HOLD_MS` is configured but not enforced as a total account-lock fairness budget.
- The old spec's `INITIAL_BATCH_STALL_TIMEOUT_MS` is not present.
- Stuck `DEGRADED` for 24h with no successful priority sync is not implemented.
- Folder-count explosion cap and reactive rediscovery on missing-mailbox errors remain open deltas in `docs/spec-conformance.md`.

## Next Best Actions

- Keep this file updated at the end of substantial sessions.
- If a session includes private provider/customer details, summarize only safe facts here and keep private detail in `.context/`.
- When repo layout, scripts, CI, deploy config, schema paths, startup flow, task boundaries, or verification lanes change, update the relevant docs and note the docs / harness decision in the PR body.
