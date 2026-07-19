# SupaMail

[![CI](https://github.com/fedster99/supamail/actions/workflows/ci.yml/badge.svg)](https://github.com/fedster99/supamail/actions/workflows/ci.yml)

Reliable IMAP sync for Supabase.

SupaMail turns any IMAP inbox into queryable Supabase tables. It runs a worker/API, connects to your mailboxes, and keeps folders, messages, flags, full MIME bodies, attachment metadata, and sync health up to date in Postgres.

The simplest low-cost deployment is Supabase + Fly.io: Supabase hosts the database, Fly runs the always-on worker, and your app reads email from its own tables. The API is optional and can run as a separate Fly app when you need remote control endpoints.

## Background

I kept running into the same annoying problem at work.

Every new AI email tool integrates with Gmail. Some integrate with Outlook. But if your inbox is on any other email provider, you are usually out of luck. In my case, it was Rackspace.

And that makes sense. IMAP is old. It is messy. It has folders, weird cursors, UIDVALIDITY resets, flags, MIME bodies, provider quirks, silent failures, and a thousand tiny ways to miss an email.

But email is too valuable to leave locked behind whatever provider you happen to use.

So I built SupaMail.

It syncs any IMAP inbox into Supabase. Reliably. Full messages, folders, flags, bodies, attachments metadata, sync health, all of it.

The point is simple: once email is in Supabase, you can build whatever you want on top of it.

AI agents. Internal tools. CRM workflows. Search. Alerts. Automations.

SupaMail is the boring sync layer that makes the fun stuff possible.

## What You Get

- IMAP accounts and folder state
- Initial and incremental message sync
- UIDVALIDITY reset handling
- Reconciliation for provider deletes and missing messages
- Flags, headers, threading headers, and MIME structure
- Durable, account-scoped conversation threading with mirrored-copy deduplication
- Raw RFC822/MIME bodies (retention configurable via `BODY_STORAGE_MODE`)
- Parsed text, HTML, normalized text, and parser metadata
- Attachment and inline-part metadata
- Sync runs, sync events, health, lag, retries, and backoff
- Structured metadata write-service and worker-tick throughput metrics
- Per-folder and per-account progress percentages for headers and body completeness
- Folder-count safeguards for unusually large mailboxes
- Reactive rediscovery when a provider reports a mailbox no longer exists
- Provider profiles for generic IMAP and provider-specific quirks

## How It Works

```text
IMAP mailbox -> SupaMail worker/API -> Supabase/Postgres -> your app
```

SupaMail treats Postgres as the durable mailbox mirror. IMAP is the provider; Supabase is where your application reads from. Conversation membership is a deterministic, rebuildable projection over the mirrored headers; it never rewrites the observed message rows.

Account-level advisory locks keep sync operations serialized. Folder state tracks UID cursors and UIDVALIDITY. Reconciliation catches gaps so missing messages do not silently become permanent.

## Default Sync Edges

These are the current defaults, tuned for a small always-on worker:

- Live sync window: 90 days
- Inbox/new-mail detection: about 1-2 minutes
- Sent-folder metadata detection: about 30-60 seconds (lightweight lane; configurable)
- Folder discovery: every 15 minutes
- Message delete/move detection: about 6 hours per folder
- Folder deletion grace period: 7 days
- Priority folders per cycle: 10
- Non-priority folders per cycle: 5
- Body fetch cap: up to 100 bodies per worker tick
- Max raw MIME body: 25 MB
- Account lock budget: 10 minutes
- Default account cap: 20 accounts

Historical/deep-archive backfill is separate from the live-window health path. Treat live health as the fresh-mail reliability signal, not proof that every older message has already been mirrored.

## Repository Layout

- `apps/api`: TypeScript/Node worker, API, CLI, tests, Supabase migration, Docker, and Fly configs.
- `apps/web`: Next.js landing site.
- `docs`: reliability contract, deployment notes, architecture decisions, and agent operating docs.
- `SESSION_HANDOFF.md`: tracked restart notes for future coding agents.

## Quickstart: Supabase + Fly.io

1. Create a Supabase project.
2. Use the direct/session-affine Postgres connection string for `DATABASE_URL`.
3. Deploy the worker from the repository root with `apps/api/fly.worker.toml.example`.
4. Set environment variables.
5. Run migrations.
6. Add an IMAP account.

Required environment variables:

```bash
DATABASE_URL=postgresql://...
IMAP_ENCRYPTION_KEY=...
API_TOKEN=...
BODY_FETCH_POLICY=priority_then_backfill
```

Apply the schema:

```bash
pnpm migrate
```

or, if you need to run SQL manually, apply the public migration files in manifest order:

```bash
for file in apps/api/supabase/migrations/public/*.sql; do
  psql "$DATABASE_URL" -f "$file"
done
```

Important: use a direct Supabase Postgres URL or the Supavisor session pooler on port `5432`. Do not use the transaction pooler on port `6543`. SupaMail uses advisory locks, and advisory locks need session affinity.

See [docs/fly-supabase.md](docs/fly-supabase.md) for the full Fly.io + Supabase setup.

See [docs/hosted-product-boundary.md](docs/hosted-product-boundary.md) for what belongs outside the open-source core.

See [docs/hosted-cloud-contracts.md](docs/hosted-cloud-contracts.md) for the public contracts that the private hosted SaaS layer must consume.

See [docs/imap-auth-v1.md](docs/imap-auth-v1.md) for the v1 IMAP authentication scope.

See [docs/imap-compatibility.md](docs/imap-compatibility.md) for the provider compatibility matrix, minimum IMAP contract, and manual smoke checklist.

See [docs/spec-conformance.md](docs/spec-conformance.md) for the public reliability matrix against the old Signal sync-engine spec that SupaMail was extracted from.

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

## Conversation Threading

SupaMail keeps three identities separate:

- A **physical mailbox row** is one `(account, folder, UIDVALIDITY, UID)` occurrence.
- A **delivery** is one email that may have physical copies in several folders.
- A **conversation** is the transitive reply graph containing one or more deliveries.

Threading is deliberately conservative. Exact provider delivery identities and verified copy fingerprints deduplicate physical copies. Raw-MIME, complete parsed-representation, and transport-invariant authored-representation hashes are independent evidence tokens; copies with the same strict Message-ID collapse when any token matches. The authored token handles Sent/Inbox copies whose receiving server added trace/authentication headers or changed wire size: it still requires identical authored headers, envelope, parsed bodies, MIME structure, parser outcome, and complete structured/attachment evidence. The bounded worker derives it after distinct delivery candidates are observed or when an exact-metadata match needs corroboration; a mismatch remains split. V3 may recover a cross-folder mirror only when strict Message-ID, timestamp, byte size, normalized subject, sender, and every recipient match exactly; same-folder reuse and conflicting authored digests remain split. Valid RFC `References` ancestry is preferred; the first valid `In-Reply-To` is used only when `References` has no usable Message-ID. A referenced Message-ID that has not arrived yet becomes a provisional parent, so siblings stay together and a later parent converges into the same graph. A directly prefixed forward starts a new protocol conversation even when a client inherited reply or provider-thread headers; replies to that forwarded outer may form their own branch. Namespaced, account-scoped provider thread IDs are otherwise a secondary grouping hint.

Subject matching is only a last resort: an otherwise standalone `Re:` can join exactly one recent root when the base subject and reciprocal participants match exactly. Forwards, list/bulk mail, automated replies, ambiguous candidates, and content similarity never trigger this fallback. Weak evidence runs only over one exact, bounded subject bucket; an oversized common subject is recorded and skipped rather than guessed.

Assignments live in versioned `imap_thread_runs`, with one `imap_thread_assignments` row per physical message and run. Metadata/body changes fan out to every active, standby, ready, and building run. Initial builds, rebuilds, and upgrades remain invisible shadow projections until they are complete and caught up. By default every shadow waits for explicit review and atomic activation. A deployment may set `THREADING_AUTO_ACTIVATE_INITIAL=true` to activate only the first projection after the same coverage, evidence-revision, and empty-queue checks pass; rebuilds and upgrades still require explicit review, and replacement activation still requires a passing comparison certificate. Operators can run the same deterministic machinery directly:

```bash
pnpm --filter @supamail/api exec tsx src/cli.ts threads-drain \
  --account-id <account-uuid>

pnpm --filter @supamail/api exec tsx src/cli.ts threads-rebuild \
  --account-id <account-uuid> \
  --reason "algorithm upgrade"

pnpm --filter @supamail/api exec tsx src/cli.ts threads-compare \
  --account-id <account-uuid> \
  --baseline-run-id <active-run-uuid> \
  --candidate-run-id <ready-run-uuid>

pnpm --filter @supamail/api exec tsx src/cli.ts threads-activate \
  --account-id <account-uuid> \
  --run-id <ready-run-uuid> \
  --comparison-id <passed-comparison-uuid> \
  --reason "benchmark passed" \
  --confirm

pnpm --filter @supamail/api exec tsx src/cli.ts threads-rollback \
  --account-id <account-uuid> \
  --operation-id <latest-operation-uuid> \
  --confirm

pnpm --filter @supamail/api exec tsx src/cli.ts threads-prune \
  --older-than-days 30 \
  --batch-size 100 \
  --confirm
```

`threads-rebuild` never switches readers by itself. `threads-compare` stores a
quality certificate for the exact baseline/candidate generations and mirror
evidence revision. Any later mail invalidates it. Activation requires a passed
certificate when replacing an active run, verifies full physical-row coverage
and empty catch-up queues, then swaps one account-scoped active-run pointer.
Rollback is audited and pauses automatic work until a clean shadow rebuild is
activated. A database trigger provides the evidence clock and queue fan-out even
during a rolling deploy with an older sync worker. Daily retention prunes old
terminal projection runs in bounded batches but keeps operations, comparisons,
and incremental before/after history. A persisted weighted scheduler gives the
active projection three of every five available turns while reserving bounded
progress for the rollback standby and shadow build. Production executors live in
an explicit version registry; worker startup and direct drain/rebuild commands
fail fast if any state-referenced run has no retained executor.

`read_thread` and the `thread` CLI command expose the durable `conversation_id`. Search returns one best result per conversation by default and counts one representative per delivery, so mirrored copies do not inflate results. Whole-thread mailbox mutations intentionally fan out to every live physical row.

This is protocol conversation threading only. SupaMail does not infer that separate conversations concern the same task, document, or decision, and it has no work-item, CRM, belief, or epistemic clustering layer.

## Body Sync

`BODY_FETCH_POLICY` controls when full bodies are fetched:

- `immediate`: fetch body rows for every in-window message during sync.
- `lazy`: fetch bodies only when `refetch-body` or the API endpoint is called.
- `priority_then_backfill`: fetch bodies for priority folders such as INBOX and Sent during normal sync. This is the default.

Historical backfill is controlled per account through `PATCH /accounts/:id/settings`:

- `historicalBackfillMode: "off"` keeps only the live window mirrored.
- `historicalBackfillMode: "metadata_only"` mirrors older headers/envelopes without old bodies.
- `historicalBackfillMode: "metadata_and_bodies"` mirrors older headers and fetches older bodies in the history lane.
- `maxBackfillRate` controls history batches per sync tick: `small`, `normal`, or `aggressive`.

IMAP headers arrive much faster than full MIME bodies. SupaMail exposes progress percentages so downstream search, agent, or UI consumers can decide how much body completeness they need before trusting deep search results.

SupaMail stores raw RFC822/MIME bytes plus parsed text, HTML, headers, MIME structure, selected text part, and parser warnings.

`BODY_STORAGE_MODE` controls whether the raw blob is retained:

- `raw_mime`: store the original RFC822/MIME bytes in `imap_message_bodies.raw_mime`. This is the default.
- `parsed_only`: stream and parse bodies without retaining the complete RFC822 source buffer, then store `raw_mime` as NULL. Raw blobs usually dominate database size, so use this when you only need parsed/searchable content. `raw_bytes`, `raw_truncated`, and `raw_mime_sha256` are computed during the stream, and threading derives a strict digest over the complete parsed representation to corroborate mirrored copies without trusting Message-ID alone. Raw MIME cannot be re-read later for re-parsing or attachment extraction.

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

This starts a disposable `postgres:16-alpine` container on a random localhost port, applies the migration twice, runs the DB-backed sync engine suites, runs spec conformance, and removes the container. Set `KEEP_DB=1` to leave the container running for inspection.

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
```

Load smoke test:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres \
IMAP_ENCRYPTION_KEY=local-dry-run-encryption-key \
NODE_OPTIONS=--max-old-space-size=160 \
pnpm --filter @supamail/api smoke:load
```

`pnpm --filter @supamail/api dry-run:local` uses a fake IMAP client with fixture folders, messages, MIME bodies, and attachment metadata. `pnpm --filter @supamail/api smoke:greenmail` starts a disposable `greenmail/standalone` Docker IMAP/SMTP server and syncs through the real IMAP protocol. `pnpm --filter @supamail/api smoke:dovecot` starts a disposable `dovecot/dovecot` Docker IMAP server with seeded Maildir data to validate the generic-hosting shape. See [docs/imap-compatibility.md](docs/imap-compatibility.md) before claiming support for a specific provider.

## Project Status

SupaMail is early and intentionally focused on the mailbox protocol layer. No calendar, contacts, CRM, identity hydration, work-item clustering, or AI features are included in the core.

The repo is independent from the app it came from. It excludes CRM hydration, person/company identity resolution, handle mapping, identity/belief code, MCP routes, Trigger.dev coupling, and internal dashboard logic.
