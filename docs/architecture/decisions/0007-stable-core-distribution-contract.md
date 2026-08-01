# ADR 0007: Publish Stable Core Distribution Contracts

Status: Accepted

Date: 2026-05-22

## Context

Self-hosters and other downstream deployments need immutable application artifacts, ordered public migrations, runtime entrypoints, and a scheduler contract without importing deployment-specific account or infrastructure logic into the core.

## Decision

The repository publishes Node 24 container images, ordered public mirror migrations, runtime entrypoints, and database-agnostic target-scheduler types.

Public migrations live only under `apps/api/supabase/migrations/public/`. The manifest records their order and the required public schema version. Deployment-specific schemas and account lifecycle data must not enter this migration path.

Consumers must pin immutable image digests or SHA tags and apply the required public migrations before starting a newer core image. Scheduler tasks use bounded global/per-target concurrency, skip paused or stale-schema targets, and isolate target failures.

## Consequences

- Public artifacts remain reproducible and safe for downstream use.
- Deployment-specific systems compose around the core rather than changing its public schema.
- Every public migration updates the manifest and remains additive and idempotent.

## Verification

- `apps/api/src/__tests__/schema.test.ts` verifies manifest and migration-path behavior.
- `apps/api/src/__tests__/target-scheduler.test.ts` verifies concurrency, skip, and failure-isolation behavior.
- `apps/api/src/__tests__/deployment-config.test.ts` verifies runtime pinning and image publication.

## References

- `apps/api/supabase/migrations/public/manifest.json`
- `docs/deployment-options.md`
