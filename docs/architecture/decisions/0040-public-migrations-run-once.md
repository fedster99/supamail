# ADR 0040: Each Public Migration Runs Once

Status: Accepted

Date: 2026-10-06

## Context

`applyPublicMigrations` concatenated every public migration and ran the whole
set on every migrate. Every file had to stay safe to re-run, and that rule
leaked into design:

- A migration could not drop an index or column an earlier file creates: the
  next migrate re-ran the earlier file and rebuilt it, under a write-blocking
  lock on the largest table.
- A one-time data repair had to carry its own marker, because it ran again on
  every migrate.
- Every deploy re-validated every object of every migration.

Hosts that apply migrations through their own history tool already ran each
file once.

## Decision

**`applyPublicMigrations` applies each public migration once.**

- `supamail_meta.public_migrations (id, applied_at)` records applied ids. The
  schema is outside the API-exposed schemas and grants nothing to `PUBLIC`.
- Under the existing advisory lock, the runner applies each manifest id that is
  not recorded, in manifest order, and records it in the same transaction. A
  failed migration records nothing and stops the run.
- A database migrated before the record existed has no ids recorded, so it
  applies every file once more and records them all. Every existing file is
  idempotent, so this is the same work as before, done for the last time.

## Consequences

- Later migrations may drop columns, indexes, and other objects that earlier
  files create.
- Public migrations stay idempotent: a database without the record still applies
  every file once.
- Other runners that apply the public files (for example a host's provisioning
  of customer databases) must use the same record, or keep applying every file.
