# ADR 0007: Public Core Hosted Cloud Contract

Status: Accepted

Date: 2026-05-22

## Context

SupaMail needs a public OSS core and a private hosted SaaS from the start. The same sync engine must support self-hosted OSS, BYO Supabase hosted workers, and later managed tenants without copying hosted billing or provisioning code into the public repo.

## Decision

The public repo is the canonical core. It publishes Node 24 Docker images, public mirror migrations, runtime entrypoints, and scheduler contracts. The private hosted repo consumes a pinned public image digest and owns Supabase Auth, Stripe, Supabase OAuth, tenant provisioning, remote MCP auth, and control-plane migrations.

Public migrations live only under `apps/api/supabase/migrations/public/`. Hosted control-plane migrations must not live in this repo and must never be applied to customer BYO Supabase projects.

The hosted runtime starts with one Fly app, one machine, and one Node process using `SUPAMAIL_MODE=combined`. It should use global and per-target concurrency caps and skip paused, needs-attention, or stale-migration targets.

V1 hosted billing is one `$5/month` BYO Supabase subscription with a 7-day no-card trial and Stripe customer portal. Gmail and Microsoft OAuth for mailbox auth are deferred; v1 mailbox auth is username/password or provider app password.

## Consequences

Public contributors keep a normal OSS workflow. Hosted code stays private. The cloud repo must pin and migrate against explicit public core versions rather than deploying arbitrary `main`.

Future public migrations must update the public manifest. Future private control-plane schema changes must be made in the private hosted repo.

## Verification

- `apps/api/src/__tests__/schema.test.ts` verifies public migration manifest behavior and that control-plane migrations are not in the public package path.
- `apps/api/src/__tests__/target-scheduler.test.ts` verifies global concurrency, per-target concurrency, stale target skips, and failure isolation.
- `apps/api/src/__tests__/deployment-config.test.ts` verifies Node 24 pinning and the GHCR publish workflow.

## References

- `docs/hosted-cloud-contracts.md`
- `docs/hosted-product-boundary.md`
- `docs/imap-auth-v1.md`
