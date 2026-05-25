# ADR 0006: Use Docs/Harness Impact Reminder Before PR Updates

Status: Accepted

Date: 2026-05-20

## Context

The repo moved from a root API package to a Turborepo with `apps/api` and `apps/web`, but the project docs and agent instructions were not updated in the same push. That left `AGENTS.md`, architecture docs, deployment docs, and verification notes partially stale.

The harness failed because it relied on agent memory instead of a forced impact checkpoint.

## Decision

Add a Harness Impact section to the pull request template. Before pushing or updating a PR, agents should explicitly choose one:

- Project docs / harness reviewed and updated where needed.
- Project docs / harness reviewed; no updates needed.

The PR should also include a one-sentence harness note. `pnpm harness:check` reminds local agents during normal verification to check whether project docs or agent instructions became stale. It does not attempt to prove whether docs are correct.

## Consequences

- Agents see the reminder during `./init.sh`, before the normal typecheck/test/build flow.
- The reminder is broad and durable rather than a brittle path detector.
- This does not prove the decision is correct, but it makes project-docs and harness review part of the normal pre-git ritual.

## Verification

- `.github/pull_request_template.md` defines the required section.
- `scripts/check-harness-impact.mjs` prints the reminder.
- `package.json` exposes `pnpm harness:check`.
- `init.sh` runs it before typecheck.
- `.github/pull_request_template.md` includes the Harness Impact section.

## References

- `AGENTS.md`
- `docs/agent/verification.md`
- `.github/pull_request_template.md`
- `scripts/check-harness-impact.mjs`
