<p align="center">
  <img src=".github/assets/supamail-readme-hero.svg" alt="SupaMail mirrors an IMAP mailbox through its sync engine into Postgres, with SQL, CLI, and MCP access." width="100%">
</p>

<p align="center">
  <strong>Mirror an IMAP mailbox into Postgres, then build with SQL, TypeScript, or MCP.</strong>
</p>

<p align="center">
  <a href="https://github.com/fedster99/supamail/actions/workflows/ci.yml"><img src="https://github.com/fedster99/supamail/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f5f1e8.svg?labelColor=0b0d0c" alt="MIT License"></a>
  <a href=".nvmrc"><img src="https://img.shields.io/badge/node-24-b7ff52.svg?labelColor=0b0d0c" alt="Node 24"></a>
</p>

<p align="center">
  <a href="#quickstart-supabase--flyio">Quickstart</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#agent-and-cli-access">Agent access</a> ·
  <a href="docs/imap-compatibility.md">Compatibility</a> ·
  <a href="docs/deployment-options.md">Deploy</a>
</p>

SupaMail is the self-hosted sync layer between an IMAP mailbox and your
application. It keeps folders, messages, flags, MIME bodies, attachment
metadata, conversation threads, and sync health queryable in Postgres. Use
Supabase for a convenient database layer, or bring a standard Postgres
deployment.

> SupaMail is intentionally the boring infrastructure underneath search,
> automations, internal tools, and email agents. It does not send mail or embed
> an AI model.

## What you get

| | |
| --- | --- |
| **Mailbox mirror** | Initial and incremental sync for folders, headers, flags, MIME bodies, and attachment metadata |
| **Reliability** | UIDVALIDITY recovery, reconciliation, retries, backoff, health, lag, and progress |
| **Conversation model** | Durable account-scoped threading with mirrored-copy deduplication |
| **Developer access** | Postgres tables, a machine-readable CLI, a token-protected API, and five read-only local MCP tools |

## How it works

IMAP remains the source of truth; Postgres becomes the durable mailbox mirror
your application reads. Account-level advisory locks serialize sync work.
Per-folder cursors and UIDVALIDITY track change, while reconciliation catches
gaps so missing messages do not silently become permanent.

The default worker prioritizes fresh mail and recent bodies. Historical archive
backfill runs separately, so live health describes the fresh-mail path rather
than claiming every old message is already mirrored.

## Quickstart: Supabase + Fly.io

The simplest low-cost deployment uses Supabase for Postgres and Fly.io for the
always-on worker. Clone the repository, install dependencies, and set these
variables:

```dotenv
DATABASE_URL=postgresql://...
IMAP_ENCRYPTION_KEY=...
API_TOKEN=...
BODY_FETCH_POLICY=priority_then_backfill
```

Use a direct Supabase Postgres URL or the Supavisor session pooler on port
`5432`. Do not use the transaction pooler on port `6543`: advisory locks require
session affinity.

Then apply the schema:

```bash
pnpm install
pnpm migrate
```

Deploy the worker from the repository root with
`apps/api/fly.worker.toml.example`, then add a mailbox below. The API is
optional; run it separately only when you need remote control endpoints.

If you need to run SQL manually, apply the public migration files in manifest
order:

```bash
for file in apps/api/supabase/migrations/public/*.sql; do
  psql "$DATABASE_URL" -f "$file"
done
```

See [docs/fly-supabase.md](docs/fly-supabase.md) for the full Fly.io + Supabase setup.

See [docs/imap-auth-v1.md](docs/imap-auth-v1.md) for the v1 IMAP authentication scope.

See [docs/imap-compatibility.md](docs/imap-compatibility.md) for the provider compatibility matrix, minimum IMAP contract, and manual smoke checklist.

See [docs/spec-conformance.md](docs/spec-conformance.md) for the public reliability contract and its verification matrix.

## Add a Mailbox

```bash
pnpm install
pnpm migrate

pnpm --filter @supamail/api exec tsx src/cli.ts create-account \
  --email alice@example.com \
  --host imap.example.com \
  --port 993 \
  --username alice@example.com \
  --password "$IMAP_PASSWORD" \
  --profile generic-imap
```

Then start the worker:

```bash
pnpm build
pnpm --filter @supamail/api start:worker
```

Or run the API:

```bash
pnpm --filter @supamail/api start:api
```

The Docker/runtime entrypoint also supports `SUPAMAIL_MODE=worker|api|combined`. `combined` runs the API and worker in one Node process for small deployments.

## Query Your Email

Recent messages:

```sql
select
  m.id,
  m.internal_date,
  m.from_email,
  m.subject,
  m.flags,
  m.body_fetched_at
from imap_messages m
where m.deleted_in_provider = false
order by m.internal_date desc
limit 50;
```

Full body:

```sql
select
  m.subject,
  b.body_text,
  b.body_html,
  b.raw_bytes,
  b.fetched_at
from imap_messages m
join imap_message_bodies b on b.message_id = m.id
where m.id = '<message-id>';
```

Sync health:

```sql
select
  email_address,
  sync_state,
  sync_state_reason,
  priority_sync_lag_seconds,
  overall_sync_lag_seconds,
  last_sync_finished_at
from imap_accounts;
```

Progress roll-up:

```sql
select
  a.email_address,
  p.live_headers_complete_pct,
  p.priority_bodies_complete_pct,
  p.live_bodies_complete_pct,
  p.historical_headers_complete_pct,
  p.historical_bodies_complete_pct
from imap_accounts a
join imap_account_progress p on p.account_id = a.id;
```

## Agent and CLI Access

SupaMail includes a machine-readable CLI and a local stdio MCP server over the
same Postgres mirror.

Common CLI reads:

```bash
pnpm --filter @supamail/api exec tsx src/cli.ts search "from:alice@example.com is:unread"
pnpm --filter @supamail/api exec tsx src/cli.ts message <message-id>
pnpm --filter @supamail/api exec tsx src/cli.ts thread <message-id>
pnpm --filter @supamail/api exec tsx src/cli.ts folders --account <account-id>
```

The MCP server exposes five agent tools: `search_email`, `read_message`,
`read_thread`, `list_folders`, and `draft_reply`. It uses local stdio transport,
reads the same `DATABASE_URL`, and has no remote listener or send capability.

`read_thread` accepts one message seed or a batch of up to ten `message_ids`,
preserving first-seen order and isolating each thread's result or error.
`read_message` and `read_thread` return the full available cleaned body for each
message. `read_message` also accepts an optional body range without a product
character ceiling. Every message and thread explicitly reports whether text or
older messages are absent and gives the exact omission reason.

```bash
pnpm build
DATABASE_URL=postgresql://... \
pnpm --filter @supamail/api start:mcp
```

See [the Agent Email Guide](apps/api/docs/AGENT_EMAIL.md) for tool contracts,
identity rules, sync-trust semantics, and MCP client guidance.

## Conversation Threading

SupaMail keeps physical mailbox rows, deliveries, and conversations as separate
identities. It conservatively deduplicates mirrored copies, builds conversations
from RFC reply ancestry and bounded provider evidence, and stores the result as a
versioned projection without rewriting observed message rows.

`read_thread` and the `thread` CLI command expose the durable
`conversation_id`. Search returns one best result per conversation by default,
so mirrored folder copies do not inflate results.

This is protocol-level conversation threading, not semantic grouping. For the
evidence rules, rebuild/compare/activate lifecycle, rollback guarantees, and
operator commands, read
[ADR 0024: Durable conversation threading](docs/architecture/decisions/0024-durable-conversation-threading.md).

## Body Sync

`BODY_FETCH_POLICY` controls when full bodies are fetched:

- `immediate`: fetch body rows for every in-window message during sync.
- `lazy`: fetch bodies only when `refetch-body` or the API endpoint is called.
- `priority_then_backfill`: fetch bodies for priority folders such as INBOX and Sent during normal sync. This is the default. It does not later fetch current messages from non-priority folders.

An existing account can change this policy through
`PATCH /accounts/:id/settings`:

```json
{
  "bodyFetchPolicy": "immediate"
}
```

The new value takes effect on the next normal body-lane pass. Use `immediate`
when the product requires complete live-window bodies across all tracked
folders.

Historical backfill is controlled per account through `PATCH /accounts/:id/settings`:

- `historicalBackfillMode: "off"` keeps only the live window mirrored.
- `historicalBackfillMode: "metadata_only"` mirrors older headers/envelopes without old bodies.
- `historicalBackfillMode: "metadata_and_bodies"` mirrors older headers and fetches older bodies in the history lane.
- `maxBackfillRate` controls history batches per sync tick: `small`, `normal`, or `aggressive`.

IMAP headers arrive much faster than full MIME bodies. SupaMail exposes progress
percentages so downstream search, agent, or UI consumers can decide how much
body completeness they need before trusting deep search results.

Live and priority body percentages describe current active `IN_WINDOW`
messages. The target includes messages in tracked, non-missing folders that are
not deleted at the provider. A body is complete only when its
`imap_message_bodies` row exists and `raw_truncated` is false. A complete
`parsed_only` row counts even though `raw_mime` is NULL.

The cumulative folder counters remain useful telemetry, but they are not the
source of truth for current live body coverage. A truncated row stays visible as
incomplete and does not retry forever automatically. Use
`POST /messages/:id/refetch-body` only after the cause is corrected. For
example, raise `BODY_RAW_MAX_BYTES` before you retry a message that exceeded the
configured cap.

`GET /accounts/:id` applies the same completeness test within each returned
folder. Each folder row adds `live_bodies_fetched_count` and
`live_bodies_target_count`, and its `bodies_pct` uses those current row counts.
Folder rows still report untracked, missing, and pending folders, so their
targets do not always sum to the active account target. The older
`bodies_fetched_count` remains cumulative telemetry.

Migration `0021_row_accurate_body_progress` adds the partial
`imap_messages_live_body_progress_idx`. On a large existing mirror, create this
exact index concurrently before you apply the transactional migration:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS imap_messages_live_body_progress_idx
  ON public.imap_messages (account_id, folder_path, id)
  WHERE deleted_in_provider = false
    AND window_status = 'IN_WINDOW';
```

SupaMail stores raw RFC822/MIME bytes plus parsed text, HTML, headers, MIME structure, selected text part, and parser warnings.

`BODY_STORAGE_MODE` controls whether the raw blob is retained:

- `raw_mime`: store the original RFC822/MIME bytes in `imap_message_bodies.raw_mime`. This is the default.
- `parsed_only`: parse bodies and store `raw_mime` as NULL. The body lane can fetch up to 10 known-complete, same-folder messages of at most 4 MiB each with one UID-set command, capped at 8 MiB of source across the batch. It drains and parses that bounded command before body storage. Larger, unknown-size, singleton, and cap-limited messages use the streaming download path. Raw blobs usually dominate database size, so use this when you only need parsed/searchable content. `raw_bytes`, `raw_truncated`, and `raw_mime_sha256` are computed during parsing, and threading derives a strict digest over the complete parsed representation to corroborate mirrored copies without trusting Message-ID alone. Raw MIME cannot be re-read later for re-parsing or attachment extraction.

Before enabling `parsed_only`, apply the public migrations (`pnpm migrate`) so `raw_mime` is nullable; on an un-migrated database every body store fails. While `parsed_only` is active, any re-fetch of an already-stored message (for example `POST /messages/:id/refetch-body` or a UIDVALIDITY-reset re-walk) also overwrites that row's previously stored `raw_mime` with NULL. Switching back to `raw_mime` does not backfill raw blobs for mail synced while `parsed_only` was active.

Attachment binaries are not downloaded by default. SupaMail stores attachment metadata, MIME part numbers, content IDs, and optional future storage keys.

## API

`API_TOKEN` is required to run the API service. Every endpoint except `/health` requires `Authorization: Bearer $API_TOKEN`.

- `GET /health`
- `POST /migrate`
- `GET /accounts`
- `GET /accounts/:id`
- `POST /accounts`
- `POST /accounts/:id/sync`
- `POST /accounts/:id/folders/track`
- `PATCH /accounts/:id/credentials`
- `PATCH /accounts/:id/settings`
- `POST /messages/:id/refetch-body`

Account responses intentionally omit encrypted passwords, lock IDs, and worker internals. `GET /accounts/:id` includes account progress percentages and per-folder progress rows.

`PATCH /accounts/:id/credentials` replaces a rejected password or app password under the account advisory lock. It resets terminal auth failure to `DEGRADED` with `CREDENTIALS_UPDATED_PENDING_SYNC`; the next successful sync establishes `HEALTHY` rather than the credential write claiming health prematurely.

Example:

```bash
curl -X POST "$API_URL/accounts" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "emailAddress": "alice@example.com",
    "host": "imap.example.com",
    "port": 993,
    "secure": true,
    "username": "alice@example.com",
    "password": "secret",
    "providerProfile": "generic-imap",
    "bodyFetchPolicy": "priority_then_backfill"
  }'
```

## Library Hooks

Library users can instantiate `MirrorEngine` with hooks:

```ts
new MirrorEngine({
  hooks: {
    onMessageUpsert: async (message) => {},
    onBodyFetched: async (message, body) => {},
    onMessageDeleted: async (message) => {},
    onFolderChanged: async (folder) => {},
    onSyncRunCompleted: async (result) => {}
  }
});
```

The `@supamail/api` barrel also exports the shared MCP registry, handlers, and
`MCP_INSTRUCTIONS` for deployment wrappers. Its `cleanBody` TypeScript helper
uses camelCase options and range metadata (`includeQuoted`, `offset`, `maxChars`,
`totalChars`, `nextOffset`, and `omissions`); MCP requests and results use the
snake_case field names documented in the Agent Email Guide.

## Deployment Options

- `apps/api/fly.worker.toml.example`: low-cost Fly.io worker-only deployment
- `apps/api/fly.api.toml.example`: optional Fly.io API deployment
- `apps/api/compose.yaml`: Docker Compose / Coolify / VPS deployment

See [docs/deployment-options.md](docs/deployment-options.md) for tradeoffs.

## Local Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm test:db:live
pnpm build
```

Live DB reliability tests:

```bash
pnpm test:db:live
```

This first runs the Docker lifecycle regression (success, failure, `SIGINT`,
`SIGTERM`, and parallel isolation), then starts a disposable
`postgres:16-alpine` container on a random localhost port, applies the migration
twice, runs the DB-backed sync engine suites, and runs spec conformance. Each
database uses its own named volume. The container and volume carry
`io.supamail.ephemeral=true`, run ID, purpose, and creation-time labels and are
removed together. Set `KEEP_DB=1` to leave the live-test container and named
volume running for inspection.

To inspect labeled resources left by `KEEP_DB=1`, `SIGKILL`, a Docker crash, or
a machine crash:

```bash
docker volume ls \
  --filter label=io.supamail.ephemeral=true \
  --format '{{.Name}}\t{{.Label "io.supamail.purpose"}}\t{{.Label "io.supamail.run-id"}}\t{{.Label "io.supamail.created-at"}}'
```

Before removing a stale volume, inspect its labels and confirm that no container
uses it. Then remove that exact volume by name:

```bash
VOLUME_NAME=supamail-db-live-data-EXACT_RUN_ID
docker volume inspect "$VOLUME_NAME"
docker ps -a --filter volume="$VOLUME_NAME"
docker volume rm "$VOLUME_NAME"
```

Do not use `docker volume prune`: unrelated developer databases may be valuable.

Local Supabase dry run:

```bash
supabase db start --workdir apps/api/supabase

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres \
IMAP_ENCRYPTION_KEY=local-dry-run-encryption-key \
pnpm migrate

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres \
IMAP_ENCRYPTION_KEY=local-dry-run-encryption-key \
pnpm --filter @supamail/api dry-run:local
```

Protocol smoke test:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres \
IMAP_ENCRYPTION_KEY=local-dry-run-encryption-key \
pnpm --filter @supamail/api smoke:greenmail

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres \
IMAP_ENCRYPTION_KEY=local-dry-run-encryption-key \
pnpm --filter @supamail/api smoke:dovecot

IDLE_SCALE_WATCHERS=1000 \
IDLE_SCALE_DURATION_MS=60000 \
pnpm smoke:idle-scale
```

Load smoke test:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres \
IMAP_ENCRYPTION_KEY=local-dry-run-encryption-key \
NODE_OPTIONS=--max-old-space-size=160 \
pnpm --filter @supamail/api smoke:load
```

`pnpm --filter @supamail/api dry-run:local` uses a fake IMAP client with fixture folders, messages, MIME bodies, and attachment metadata. `pnpm --filter @supamail/api smoke:greenmail` starts a disposable `greenmail/standalone` Docker IMAP/SMTP server and syncs through the real IMAP protocol. `pnpm --filter @supamail/api smoke:dovecot` starts a disposable `dovecot/dovecot` Docker IMAP server with seeded Maildir data to validate the generic-hosting shape. `pnpm smoke:idle-scale` measures real ImapFlow TLS IDLE session capacity against a synthetic server; it does not validate a provider. See [docs/imap-compatibility.md](docs/imap-compatibility.md) before claiming support for a specific provider.

## Project Status

SupaMail is early and intentionally focused on reusable mailbox infrastructure.
It includes local CLI and MCP contracts plus explicit API and mailbox-operation
surfaces. Product-specific business models, identity systems, and account
orchestration remain outside the open-source core.
