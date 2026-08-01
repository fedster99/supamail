# ADR 0029: Add a Neutral Metadata-Protection Adapter

Status: Accepted

Date: 2026-07-30

## Context

Some deployments need application-layer protection for sensitive email
metadata. Public core must support that protection without owning
deployment-specific identity, key, or provider logic. Default installations keep the current
readable database behavior.

The seam must protect complete relation rows rather than encrypt each field
separately. It must also preserve exact-match projections chosen by the
deployment adapter.

## Decision

- Public core defines an explicit `MetadataProtectionAdapter`.
- The adapter receives the relation kind, Mailbox Account UUID, stable record
  identity, and the relation's sensitive values.
- A protected adapter must bind the relation kind, Mailbox Account UUID, stable
  record identity, envelope version, and key version into its authenticated
  associated data. A mismatch must make reveal fail.
- Before a durable write, the adapter returns the normal column values, one
  opaque row envelope, its format and key versions, and optional opaque
  exact-match tokens.
- The returned normal-column projection must contain exactly the input fields.
  Public core rejects omitted or added fields before it writes the row.
- A field used by a public-core equality or uniqueness operation must have a
  stable projection that preserves that operation. This includes the
  case-insensitive Mailbox Account email key and the 64-character structured
  evidence hash.
- After a durable read, the adapter reconstructs the sensitive values.
- A reveal result must contain every field requested by public core. Public
  core fails closed when a field is missing.
- Public core stores the envelope and tokens. It does not derive keys, encrypt
  data, decrypt data, or interpret token names or values.
- The default adapter is an identity adapter. It stores the current readable
  values and leaves all protected-storage columns `NULL`. It rejects a
  protected row instead of treating its projected values as plaintext.
- Migration `0023_metadata_protection_seam` adds the same nullable protected
  columns to accounts, messages, message-body evidence, attachments, structured
  evidence, thread assignments, and retained thread-assignment history.
- Migration `0024_metadata_protection_mode` adds one indexed adapter-mode
  marker per Mailbox Account. It also rejects token-only protected storage.
- Public core accepts adapter injection at the API, sync-engine, repository, and
  worker construction boundaries.
- The threading repository sends assignment writes, incremental lookup
  projections, subject-work keys, and retained rollback history through the
  same adapter.
- Threading reveals protected messages, body evidence, assignments, and
  rollback history only when the in-memory algorithm needs their original
  values. Database equality operations use the adapter's stable projected
  values.
- One aggregate deadline bounds all adapter work in a threading database step.
  Database and lock time do not consume that budget. The adapter receives an
  abort signal. Timed-out calls keep their concurrency permits until they
  settle.
- Threading bounds protected envelopes, revealed input evidence, and closure
  batches. Closure state drops opaque envelopes after it extracts the indexed
  projection. Protected assignment and history writes use byte-bounded payloads
  and discard envelopes after each write. Rollback reads and restores protected
  history in bounded pages.
- Threading control operations require the adapter mode recorded on the
  Mailbox Account. This blocks mixed readable and protected projections.
- Public core does not repair missing authored-delivery evidence after a row is
  protected. It fails closed instead. A deployment must complete the existing
  plaintext repair before it protects those rows.
- The closure evidence limit measures the revealed fields that the threading
  algorithm receives. It does not use ciphertext size as a plaintext-size
  estimate.
- A deployment must not activate protected storage until every runtime read,
  write, search, and threading path can consume its protected projection.
  It must also finish the legacy plaintext body-evidence repair before
  encryption. That legacy repair does not mutate protected rows.

## Consequences

Default installation behavior does not change. Normal metadata columns
remain readable.

A deployment can supply its own adapter without adding account identity or
key-custody logic to public core. The deployment owns its field policy, key
provider, envelope format, exact-token purposes, migration, activation marker,
and fail-closed checks.

The generic columns are a storage seam. They do not provide encryption by
themselves. Installing migration `0023` does not change confidentiality.

This design does not hide plaintext from the active trusted runtime. It is not
zero knowledge.

## Verification

- Unit tests prove that the identity adapter preserves readable values.
- Unit tests prove that the identity adapter rejects protected rows.
- Unit tests prove that partial or invalid protected projections fail.
- Repository tests prove that injected output reaches the generic columns and
  that reads use the adapter.
- Threading tests prove protected incremental closure, subject fallback,
  bounded and abortable adapter work, fail-closed legacy repair, evidence
  limits, mode cutover, history, and rollback while the identity adapter
  preserves readable behavior.
- Schema tests prove that the migration contains no deployment-specific identity, key,
  encryption-algorithm, or search-provider logic.
- The normal typecheck, unit, build, and live-database lanes prove OSS parity.

## References

- `apps/api/src/metadata-protection.ts`
- `apps/api/src/repository.ts`
- `apps/api/src/threading-repository.ts`
- `apps/api/supabase/migrations/public/0023_metadata_protection_seam.sql`
- `apps/api/supabase/migrations/public/0024_metadata_protection_mode.sql`
