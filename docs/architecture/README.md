# Architecture

SupaMail is a small, stateful email mirror. IMAP is the provider; Postgres is the durable mirror; apps read from Supabase/Postgres tables.

## Runtime Components

- `src/worker.ts`: always-on poll loop, startup lock self-test, orphan lock recovery, retention, and scheduled account sync.
- `src/api.ts`: optional Hono HTTP API for health, migration, account management, manual sync, and body refetch.
- `src/cli.ts`: local operational commands such as migration and account creation.
- `src/sync-engine.ts`: account/folder sync orchestration, initial sync, incremental sync, flag scan, reconcile, body backlog.
- `src/repository.ts`: Postgres persistence and state transitions.
- `src/locks.ts`: session-scoped advisory lock behavior and stale lock recovery.
- `src/imap-client.ts`: ImapFlow adapter, throttling, metadata fetch, UID search, and full body fetch.
- `src/mime.ts`: MIME parsing, normalized text, header extraction, and attachment metadata helpers.
- `supabase/migrations/0001_imap_mirror.sql`: canonical schema.

## Data Flow

```text
IMAP provider -> worker/API -> repository -> public.imap_* tables -> user application
```

The worker and API share the same repository and account-locking model. Any IMAP operation that can affect an account must use the account advisory lock.

## Documentation Map

- Product and setup: `README.md`
- Public reliability contract: `docs/spec-conformance.md`
- Schema overview: `docs/schema.md`
- Deployment options: `docs/deployment-options.md`, `docs/fly-supabase.md`
- Agent operating guide: `docs/agent/README.md`
- Reliability invariants: `docs/agent/reliability-invariants.md`
- Architecture decisions: `docs/architecture/decisions/`

## ADR Policy

Create an ADR when a change:

- changes reliability semantics
- changes public API or data shape
- changes deployment assumptions
- chooses between durable architecture alternatives
- intentionally excludes a tempting scope

Use `docs/architecture/decisions/0000-adr-template.md` as the template. Keep ADRs short and link to code, tests, issues, or PRs that prove the decision.
