# ADR 0011: Use Pending Verification State For Missing-Mailbox Recovery

Status: Accepted

Date: 2026-05-24

## Context

Folder discovery has a grace period before an absent folder becomes `MISSING`. That protects against transient LIST glitches, but it also means a folder that is already failing with provider "mailbox does not exist" errors can be retried every sync tick until the grace expires.

The engine needs a state that says "pause normal folder sync until discovery verifies whether this mailbox still exists."

## Decision

Add `PENDING_VERIFICATION` to `imap_folders.status`.

`getFoldersDueForSync` excludes `PENDING_VERIFICATION` so normal sync does not keep selecting that folder. `upsertDiscoveredFolders` moves a reappeared `PENDING_VERIFICATION` folder back to `PENDING`, allowing the next sync cycle to rehydrate it naturally.

PR-4 lands the schema and scheduler support. PR-5 will wire missing-mailbox error detection in `syncFolder`, set `next_folder_discovery_at = now()`, and transition affected folders into `PENDING_VERIFICATION`.

## Consequences

- The schema can represent "needs rediscovery before more sync attempts" without abusing `MISSING`.
- Normal folder scheduling is safe before the reactive missing-mailbox handler lands.
- Reappeared folders recover through the existing discovery/upsert path.

## Verification

- Schema tests prove the public migration extends the status constraint.
- Repository safety tests prove `PENDING_VERIFICATION` is excluded from normal scheduling and discovery can move it back to `PENDING`.
- PR-5 will add Scenario K for the full missing-mailbox path.

## References

- `apps/api/src/repository.ts`
- `apps/api/supabase/migrations/public/0003_folder_count_cap_pending_verification.sql`
- `docs/architecture/reliability-and-three-lanes.md` D10
