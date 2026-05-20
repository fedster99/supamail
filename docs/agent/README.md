# Agent Operating Guide

This directory holds the agent-facing harness for SupaMail. It exists so coding agents can start from repository artifacts instead of rediscovering product scope, verification rules, and reliability invariants every session.

## Harness Shape

The harness follows the five-subsystem model from the `harness-creator` skill:

- Instructions: `AGENTS.md` routes to these focused docs.
- State: `docs/agent/feature-list.json` tracks feature scope; `.context/session-handoff.md` tracks local session state.
- Verification: `docs/agent/verification.md` maps change types to commands.
- Scope: WIP=1 and issue-driven task boundaries.
- Lifecycle: startup and end-of-session routines in `AGENTS.md` plus local handoff.

## Monorepo Shape

- `apps/api`: TypeScript/Node 22 IMAP mirror, worker, API, CLI, tests, Supabase migration, and deployment files.
- `apps/web`: Next.js landing site.
- Root package scripts call Turborepo or delegate into `@supamail/api`. Prefer root `pnpm typecheck`, `pnpm test`, and `pnpm build` for final verification.
- Use package filters for narrow work, for example `pnpm --filter @supamail/api test` or `pnpm --filter @supamail/web build`.

## Skill Bootstrap

This repo expects agents to have these skills installed:

- `harness-creator` from `walkinglabs/learn-harness-engineering`
- `supabase` from the official `supabase/agent-skills` package
- `supabase-postgres-best-practices` from the official `supabase/agent-skills` package

Run:

```bash
./skills.sh
```

The script installs missing skills for Codex. Codex-only skills may land in `$CODEX_HOME/skills`; skills installed through the skills.sh CLI may land in `~/.agents/skills` while being registered for the detected Codex agent. The script does not vendor those repositories into this repo.

## Read Order

For normal coding work:

1. `AGENTS.md`
2. `docs/spec-conformance.md`
3. `docs/agent/verification.md`
4. `docs/agent/feature-list.json`
5. Task-specific docs from the routing table in `AGENTS.md`

For architecture work:

1. `docs/architecture/README.md`
2. Relevant ADRs in `docs/architecture/decisions/`
3. `docs/agent/reliability-invariants.md` if sync reliability is touched

## Adding Knowledge

Put durable project facts in tracked docs close to the relevant code or topic. Put private or temporary workspace notes in `.context/`. Do not add long one-off lessons to `AGENTS.md`; create or update a focused topic doc and link it.

## Harness Impact Guard

`pnpm harness:check` reminds local agents to review project docs and agent instructions for stale guidance. It is a reminder, not a proof that every doc sentence is correct.

Here, "harness" means the agent-facing workflow docs and state surfaces that help future coding agents work correctly. This is intentionally broad rather than path-specific. If repo layout, scripts, CI, deployment, schema paths, startup flow, task boundaries, or verification lanes changed, update whatever docs became stale: `AGENTS.md`, this directory, architecture docs/ADRs, deployment docs, schema docs, README, or the public spec conformance doc. Use the PR template's Harness Impact section to record what you decided.

## Task Selection

The feature list is a scope surface, not an auto-start queue. If a feature is already `in_progress`, continue it unless the user redirects. If no feature is `in_progress`, do not start the highest-priority `not_started` item by default; use the user's task, the current PR scope, or ask for selection when the mapping is unclear.
