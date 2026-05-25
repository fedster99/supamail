# AGENTS.md

SupaMail is a TypeScript/Node 24 monorepo. `apps/api` is the IMAP mirror that syncs folders, messages, flags, MIME bodies, attachment metadata, sync health, and reliability events into Supabase/Postgres. `apps/web` is the Next.js landing site.

This file is a routing layer for coding agents. Keep detailed architecture and process rules in the linked docs instead of expanding this file.

## Startup Workflow

Before writing code:

1. Confirm you are in the repository root with `pwd`.
2. Read this file.
3. If the `harness-creator` skill is missing, run `./skills.sh` and restart Codex before harness work.
4. Read `docs/agent/README.md`.
5. Read `docs/spec-conformance.md`.
6. Read `docs/agent/feature-list.json` and follow its task-selection policy.
7. Check current git and PR state with `git status --short --branch` and, when on a PR branch, `gh pr view --json comments,reviews,statusCheckRollup`. If `gh` is unavailable or unauthenticated, record that gap and continue from local repository context.
8. Read `SESSION_HANDOFF.md`.
9. If present, read `.context/harness-assessment.md` and other relevant `.context/*.md` files for local/private context.

## Source Of Truth

- Tracked code and docs are authoritative.
- `SESSION_HANDOFF.md` is the tracked restart point for future agents.
- `docs/spec-conformance.md` is the public reliability contract.
- `.context/old-spec-used-to-build-original-signal-sync-engine.md` is private local context when present. Do not copy private-only content into tracked docs.
- GitHub issues and PR comments define active follow-up scope, but durable decisions should be promoted into docs or ADRs.

## Repository Layout

- `apps/api`: SupaMail API, worker, CLI, tests, scripts, Docker/Fly configs, and Supabase migration.
- `apps/web`: Next.js landing site. Do not turn it into a CRM/dashboard surface unless the selected task explicitly asks for that.
- `docs`: architecture, reliability, deployment, and agent-harness documentation.

## Scope Boundaries

SupaMail core owns email sync only. Do not add Signal CRM, CRM hydration, person/company identity resolution, handle mapping, belief layers, dashboard code, Trigger.dev coupling, calendar, contacts, sending, scheduling, AI features, MCP, historical backfill, or provider compatibility work unless the selected task explicitly asks for it.

When docs mention message identity, they mean mailbox-row identity: `(account_id, folder_path, uidvalidity, uid)`. Do not interpret that as permission to add CRM identity hydration or person/company modeling.

## Working Rules

- Work on one task at a time. Do not start a second feature while one is in progress.
- Do not self-start a `not_started` feature from `docs/agent/feature-list.json`. Start feature-list work only when the user asks for that issue/task or when a maintainer-selected PR scope clearly maps to it.
- Prefer small, verified changes over broad refactors.
- Do not weaken reliability semantics to make tests pass.
- Before committing, pushing, or updating a PR, run `./init.sh` so the project docs / harness reminder appears before verification. If you intentionally run verification commands individually instead of `./init.sh`, run `pnpm harness:check` before `git commit` or `gh pr edit` and record that exception.
- Keep architecture decisions in `docs/architecture/decisions/`.
- Keep progress and task state updated before ending a substantial session.
- Never claim completion from code inspection alone. Run the required verification from `docs/agent/verification.md`.

## Task-Specific Reading

- Sync engine, repository, locks, migrations, or health: read `docs/agent/reliability-invariants.md`.
- Schema changes: read `docs/schema.md` and `apps/api/supabase/migrations/public/0001_imap_mirror.sql`.
- Deployment changes: read `docs/deployment-options.md` and `docs/fly-supabase.md`.
- Web or landing-page changes: read `apps/web/app/page.tsx`, `apps/web/app/globals.css`, and `docs/architecture/README.md`.
- Architecture decisions: read `docs/architecture/README.md` and the relevant ADRs.
- Open issue work: read the issue body and acceptance criteria before editing.

## Verification

Use `docs/agent/verification.md` to choose the verification lane. Default local verification is:

```bash
pnpm typecheck
pnpm test
pnpm build
```

For sync engine, repository, locks, migrations, schema, spec invariants, or live Postgres behavior, also run:

```bash
pnpm test:db:live
```

## Definition Of Done

A change is done only when:

- The selected behavior is implemented and scoped to one task.
- Required verification ran and evidence is recorded.
- Feature/task state is updated when applicable.
- Any new architecture decision is documented as an ADR.
- The repo is left restartable for the next agent.

## End Of Session

Before ending a substantial session:

1. Update `docs/agent/feature-list.json` if task state changed.
2. Update `SESSION_HANDOFF.md` with current state, verification, blockers, and next action.
3. Put private/local details only in `.context/`.
4. Record any missing verification explicitly.
5. Leave unrelated user changes untouched.
