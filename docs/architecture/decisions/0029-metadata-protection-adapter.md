# ADR 0029: Add a Neutral Metadata-Protection Adapter

Status: Accepted

Date: 2026-07-30

## Context

Some deployments need application-layer protection for sensitive email
metadata. Public core must support that protection without owning hosted
Tenant, key, or provider logic. OSS and BYO Supabase users must keep the current
readable database behavior.

The seam must protect complete relation rows rather than encrypt each field
separately. It must also preserve exact-match projections chosen by the
deployment adapter.

## Decision

- Public core defines an explicit `MetadataProtectionAdapter`.
- The adapter receives the relation kind, Mailbox Account UUID, stable record
  identity, and the relation's sensitive values.
- Before a durable write, the adapter returns the normal column values, one
  opaque row envelope, its format and key versions, and optional opaque
  exact-match tokens.
- After a durable read, the adapter reconstructs the sensitive values.
- Public core stores the envelope and tokens. It does not derive keys, encrypt
  data, decrypt data, or interpret token names or values.
- The default adapter is an identity adapter. It stores the current readable
  values and leaves all protected-storage columns `NULL`.
- Migration `0023_metadata_protection_seam` adds the same nullable protected
  columns to accounts, messages, message-body evidence, attachments, structured
  evidence, thread assignments, and retained thread-assignment history.
- Public core accepts adapter injection at the API, sync-engine, repository, and
  worker construction boundaries.
- A deployment must not activate protected storage until every runtime read,
  write, search, and threading path can consume its protected projection.

## Consequences

OSS and BYO Supabase behavior does not change. Their normal metadata columns
remain readable.

A hosted deployment can supply its own adapter without adding Tenant or
key-custody logic to public core. The deployment owns its field policy, key
provider, envelope format, exact-token purposes, migration, activation marker,
and fail-closed checks.

The generic columns are a storage seam. They do not provide encryption by
themselves. Installing migration `0023` does not change confidentiality.

This design does not hide plaintext from the active trusted runtime. It is not
zero knowledge.

## Verification

- Unit tests prove that the identity adapter preserves readable values.
- Unit tests prove that partial or invalid protected projections fail.
- Repository tests prove that injected output reaches the generic columns and
  that reads use the adapter.
- Schema tests prove that the migration contains no hosted Tenant, key,
  encryption-algorithm, or search-provider logic.
- The normal typecheck, unit, build, and live-database lanes prove OSS parity.

## References

- `apps/api/src/metadata-protection.ts`
- `apps/api/src/repository.ts`
- `apps/api/supabase/migrations/public/0023_metadata_protection_seam.sql`
