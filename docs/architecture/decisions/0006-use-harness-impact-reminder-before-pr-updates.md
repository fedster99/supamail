# ADR 0006: Review Documentation Impact Before PR Updates

Status: Accepted

Date: 2026-05-20

## Context

Repository layout and runtime changes previously landed without updating the public documentation and contributor guidance that described them.

## Decision

The pull request template includes a Documentation Impact section. Contributors explicitly record whether public documentation or contributor guidance changed.

`pnpm harness:check` prints a reminder before the normal verification lane. It does not attempt to prove that every document is correct.

## Consequences

- Documentation review is part of the normal change workflow.
- Contributors still use judgment to decide which public documents need updates.

## Verification

- `.github/pull_request_template.md` defines the Documentation Impact section.
- `scripts/check-harness-impact.mjs` prints the reminder.
- `init.sh` runs `pnpm harness:check` before typecheck.

## References

- `AGENTS.md`
- `docs/agent/verification.md`
- `.github/pull_request_template.md`
