# Deployment Options

Supamail is just Docker plus outbound network access to IMAP and Supabase Postgres. The key production requirement is a direct or session-affine `DATABASE_URL`, because advisory locks are session-scoped.

## Recommendation

Use Render when the priority is fastest setup and low operational burden.

Use Fly.io when the priority is keeping the always-on worker bill small without moving all the way to self-hosted VPS operations. The worker can run as one Docker Machine with no public IP.

Use Coolify on a small Hetzner VPS when the priority is lowest fixed monthly cost across multiple always-on services and you are comfortable owning OS updates, Docker, Coolify upgrades, monitoring, and server backups.

## Cost Shape

| Platform | Good fit | Approximate shape |
| --- | --- | --- |
| Render | Easiest PaaS path, best default for first production deploy | Per-service fixed pricing. Worker plus API means two service bills. |
| Fly.io | Cheapest managed always-on worker path | One small Machine for the worker, optional second Machine for API. |
| DigitalOcean App Platform | Simple PaaS with worker components | Small worker is cheap and predictable; API is another component. |
| Railway | Very easy Git-based deploys | Low monthly floor, usage-based CPU/RAM can drift with workload. |
| Hetzner + Coolify | Cheapest fixed infrastructure for several services | One VPS can run worker, API, and other small services; more ops responsibility. |
| Koyeb | Good app platform, less attractive for this cost target | Current plan structure makes it a poor low-cost fit for one small worker. |

## Fly.io Worker

Worker-only deploy:

```bash
cp fly.worker.toml.example fly.toml
fly launch --no-deploy --no-public-ips
fly secrets set \
  DATABASE_URL="$DATABASE_URL" \
  IMAP_ENCRYPTION_KEY="$IMAP_ENCRYPTION_KEY"
fly deploy
```

Optional API deploy:

```bash
cp fly.api.toml.example fly.api.toml
fly launch --config fly.api.toml --no-deploy
fly secrets set --config fly.api.toml \
  DATABASE_URL="$DATABASE_URL" \
  IMAP_ENCRYPTION_KEY="$IMAP_ENCRYPTION_KEY" \
  API_TOKEN="$API_TOKEN"
fly deploy --config fly.api.toml
```

Keep the API separate from the worker so a public HTTP service cannot accidentally change the worker's uptime or cost profile.

## Coolify / VPS

Coolify can deploy this repository as a Docker Compose service. The included `compose.yaml` keeps the worker private by default and exposes the API only when the `api` profile is enabled.

Worker only:

```bash
docker compose up -d worker
```

Worker plus API:

```bash
docker compose --profile api up -d
```

In Coolify, add the repository as a Docker Compose app, set the required environment variables, and assign a domain only to the `api` service if you need remote control endpoints.

## DigitalOcean App Platform

Use the Dockerfile as the build source and create a worker component running:

```bash
node dist/worker.js
```

Create a separate web service running:

```bash
node dist/api.js
```

for the optional control API.

## Railway

Railway is a good fit for quick trials because it can deploy the Dockerfile from Git and run a worker start command:

```bash
node dist/worker.js
```

Use spend limits and watch RAM/CPU usage, because its billing is usage-based.
