# Verification Matrix

Agents must choose verification based on the files and behavior changed. Passing one narrow test is not enough when the change affects sync reliability or public behavior.

## Default Lane

Run this for most code changes:

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Change-Type Matrix

| Change area | Required verification |
| --- | --- |
| Docs only | `git diff --check`; for untracked new files, also run a trailing-whitespace check such as `rg -n "[ \t]+$" <new-files>` |
| Type-only or helper-only TypeScript change | `pnpm typecheck`, targeted `pnpm test`, `pnpm build` |
| API auth, input validation, sanitization, or response shape | `pnpm typecheck`, `pnpm test`, `pnpm build` |
| MIME parsing, host validation, crypto, provider profiles | `pnpm typecheck`, `pnpm test`, `pnpm build` |
| Sync engine, repository, locks, migrations, schema, reconcile, health, backoff, retention | `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:db:live` |
| Spec conformance behavior | `pnpm test:db:live` because it runs `pnpm spec-conformance` against live Postgres |
| Deployment files or CI | `pnpm typecheck`, `pnpm test`, `pnpm build`, plus inspect the affected config |
| GreenMail/protocol behavior | `pnpm smoke:greenmail` when Docker/local environment permits |
| Local Supabase dry run behavior | `pnpm dry-run:local` when local Supabase is available |

## Heavy Reliability Gate

`pnpm test:db:live` starts disposable Docker Postgres, applies the migration twice, runs DB-backed integration tests, runs spec conformance, and tears down the container.

Use it for any change that could alter:

- advisory lock behavior
- migration idempotence
- folder scheduling
- initial sync or incremental sync cursors
- reconcile semantics
- UIDVALIDITY reset handling
- health state transitions
- retention or purge behavior
- live Postgres query behavior

## Evidence

When completing work, record:

- commands run
- pass/fail result
- skipped commands and why
- known residual risks

Use `.context/session-handoff.md` for local handoff and `docs/agent/feature-list.json` when feature state changes.

## Bootstrap Shortcut

`./init.sh` is the full bootstrap path. In an already-bootstrapped workspace, agents may run `INSTALL_CMD=true ./init.sh` to skip reinstalling dependencies while still executing typecheck, tests, and build.
