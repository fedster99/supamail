# AGENTS.md

SupaMail is a TypeScript/Node 24 monorepo. `apps/api` mirrors IMAP mailboxes into Supabase/Postgres and exposes API, CLI, and local MCP access. `apps/web` is the public landing site.

This file is a short routing guide for contributors and coding agents. Durable product and architecture details belong in the linked public documentation.

## Before Editing

1. Confirm the repository root with `pwd`.
2. Read this file and check `git status --short --branch`.
3. Read `docs/spec-conformance.md` and `docs/agent/verification.md` for sync, schema, or reliability work.
4. Read the relevant architecture, schema, deployment, or provider documentation for the task.
5. Read the issue or pull request when the work is issue-driven.

## Repository Layout

- `apps/api`: API, worker, CLI, MCP server, tests, deployment files, and public migrations.
- `apps/web`: Next.js landing site.
- `docs`: public architecture, reliability, schema, compatibility, and deployment documentation.

## Scope

SupaMail owns the reusable mailbox mirror and its generic protocol, search, threading, read, and mailbox-operation surfaces. Application-specific business models, identity systems, and account orchestration are outside this repository.

Mailbox-row identity is `(account_id, folder_path, uidvalidity, uid)`. Conversation and delivery-copy identities are derived and must not replace that physical identity.

## Working Rules

- Work on one focused task at a time.
- Prefer small, verified changes over broad refactors.
- Do not weaken reliability or security semantics to make tests pass.
- Keep public migrations under `apps/api/supabase/migrations/public/` additive and idempotent.
- Never commit real mailbox content, credentials, tokens, customer data, private infrastructure details, or machine-specific paths.
- Keep private or temporary notes in ignored local files, never in tracked handoff diaries.
- Update public documentation when behavior, layout, scripts, schema, or verification changes.
- Leave unrelated user changes untouched.

## Task-Specific Reading

- Sync engine, repository, locks, migrations, or health: `docs/agent/reliability-invariants.md`.
- Schema changes: `docs/schema.md` and the public migration manifest.
- Deployment changes: `docs/deployment-options.md` and `docs/fly-supabase.md`.
- Web changes: `apps/web/app/page.tsx`, `apps/web/app/globals.css`, and `docs/architecture/README.md`.
- Architecture decisions: `docs/architecture/README.md` and relevant ADRs.

## Verification

Use `docs/agent/verification.md` to select the required lane. Default verification is:

```bash
pnpm harness:check
pnpm typecheck
pnpm test
pnpm build
```

For sync, repository, locks, migrations, schema, conformance, or live Postgres behavior, also run:

```bash
pnpm test:db:live
```

## Definition of Done

A change is done only when the requested behavior is implemented, the appropriate verification passes, public documentation remains accurate, and the repository is left restartable for the next contributor.
