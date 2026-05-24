# Deployment Options

SupaMail is just Docker plus outbound network access to IMAP and Supabase Postgres. The key production requirement is a direct or session-affine `DATABASE_URL`, because advisory locks are session-scoped.

For Supabase, direct Postgres uses IPv6. If the runtime cannot reach IPv6, use the Supavisor session pooler on port `5432`. Do not use the transaction pooler on port `6543`.

The Docker image uses Node 24 (`node:24-slim`). Fly and Compose examples inherit that runtime from `apps/api/Dockerfile`.

## Recommendation

Use Fly.io as the hosted path for SupaMail. It fits the shape of the product: one small always-on worker with no public IP, plus an optional separate API app only if remote control endpoints are needed.

Use Coolify on a small Hetzner VPS when the priority is lowest fixed monthly cost across multiple always-on services and you are comfortable owning OS updates, Docker, Coolify upgrades, monitoring, and server backups.

## Cost Shape

| Platform | Good fit | Approximate shape |
| --- | --- | --- |
| Fly.io | Hosted SupaMail path: managed Docker worker, no public IP required, optional API app | One small Machine for the worker, optional second Machine for API. |
| Hetzner + Coolify | Cheapest fixed infrastructure for several services | One VPS can run worker, API, and other small services; more ops responsibility. |

## Fly.io Worker

Worker-only deploy:

```bash
cp apps/api/fly.worker.toml.example apps/api/fly.worker.toml
fly launch --config apps/api/fly.worker.toml --no-deploy --no-db --no-public-ips --ha=false
fly secrets set --config apps/api/fly.worker.toml \
  DATABASE_URL="$DATABASE_URL" \
  IMAP_ENCRYPTION_KEY="$IMAP_ENCRYPTION_KEY"
fly deploy --config apps/api/fly.worker.toml --ha=false
```

`--ha=false` keeps the starter worker to one Machine. Fly otherwise creates spare/standby Machines by default for availability.

The 256 MB worker profile intentionally uses conservative runtime settings:

- `NODE_OPTIONS=--max-old-space-size=160`
- `BODY_RAW_MAX_BYTES=8388608`
- `BODY_BACKFILL_BATCH_SIZE=3`
- `INITIAL_SYNC_BATCH_SIZE=25`
- `INCREMENTAL_SYNC_BATCH_SIZE=25`

This keeps sync metadata and body parsing bounded. If a mailbox regularly has large MIME bodies or the machine OOMs, first increase `BODY_RAW_MAX_BYTES` only if needed; otherwise move the worker to `512mb`.

If your Signal repo already has the Fly and database env vars loaded locally, you can reuse them:

```bash
fly secrets set \
  DATABASE_URL="$DATABASE_URL" \
  IMAP_ENCRYPTION_KEY="$IMAP_ENCRYPTION_KEY"
```

Optional API deploy:

```bash
cp apps/api/fly.api.toml.example apps/api/fly.api.toml
fly launch --config apps/api/fly.api.toml --no-deploy --no-db --ha=false
fly secrets set --config apps/api/fly.api.toml \
  DATABASE_URL="$DATABASE_URL" \
  IMAP_ENCRYPTION_KEY="$IMAP_ENCRYPTION_KEY" \
  API_TOKEN="$API_TOKEN"
fly deploy --config apps/api/fly.api.toml --ha=false
```

Keep the API separate from the worker so a public HTTP service cannot accidentally change the worker's uptime or cost profile.

The same image also supports `SUPAMAIL_MODE=combined` for one-process API + worker deployments. That mode is intended for the private hosted SaaS runtime first; self-hosters should start with separate worker/API processes unless they specifically want one process.

## Coolify / VPS

Coolify can deploy this repository as a Docker Compose service. The included `apps/api/compose.yaml` keeps the worker private by default and exposes the API only when the `api` profile is enabled.

Worker only:

```bash
docker compose -f apps/api/compose.yaml up -d worker
```

Worker plus API:

```bash
docker compose -f apps/api/compose.yaml --profile api up -d
```

In Coolify, add the repository as a Docker Compose app, set the required environment variables, and assign a domain only to the `api` service if you need remote control endpoints.
