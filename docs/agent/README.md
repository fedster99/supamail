# Agent Operating Guide

This directory contains concise, public guidance for contributors and coding agents working on SupaMail.

## Repository Shape

- `apps/api`: TypeScript/Node 24 IMAP mirror, worker, API, CLI, MCP server, tests, migrations, and deployment files.
- `apps/web`: Next.js landing site.
- Root scripts use Turborepo or delegate to `@supamail/api`.

## Read Order

1. `AGENTS.md`
2. `docs/spec-conformance.md` for reliability or sync work
3. `docs/agent/verification.md`
4. Task-specific public documentation and ADRs
5. The relevant GitHub issue or pull request

## Public State

GitHub issues and pull requests are the primary work tracker. `docs/agent/feature-list.json` summarizes the small set of public issue-defined features that need structured status and verification evidence.

Do not track session transcripts, rolling branch diaries, private deployment state, credentials context, or machine-specific setup notes. Keep temporary working notes in ignored local files.

## Adding Knowledge

Put durable public facts close to the behavior they describe:

- `AGENTS.md`: short routing, scope, safety, and verification rules.
- `docs/spec-conformance.md`: public reliability contract.
- `docs/agent/reliability-invariants.md`: implementation invariants.
- `docs/agent/verification.md`: required verification lanes.
- `docs/architecture/`: architecture overview and accepted decisions.
- `docs/schema.md`: public mirror schema.
- `docs/deployment-options.md`: self-hosting and deployment guidance.
- `README.md`: public product overview and quickstart.

`pnpm harness:check` checks public-content hygiene and reminds contributors to review documentation impact before submitting changes.
