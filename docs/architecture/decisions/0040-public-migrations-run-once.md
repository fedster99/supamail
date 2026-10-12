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
  failed migration records nothing, stops the run, and raises
  `PublicMigrationError` with its id. A migration listed before one that already
  ran is refused the same way, because it would run out of order.
- The migrator role owns `supamail_meta`; the runner creates the schema only when
  it is missing. No runtime, reader, or API role needs access to it.
- A schema test pins the hash of every released file: a released migration never
  changes, because a database that already ran it would never see the edit.
- A database migrated before the record existed has no ids recorded, so it
  applies every file once more and records them all. Every existing file is
  idempotent, so this is the same work as before, done for the last time.

## Consequences

- Later migrations may drop columns, indexes, and other objects that earlier
  files create.
- Public migrations stay idempotent: a database without the record still applies
  every file once.
- Every runner that applies the public files (for example a host's provisioning
  of customer databases) must use the same record. Once a migration drops an
  object, re-running earlier files can fail, so only a database from before this
  record may apply every file again.
- A migration that drops an object is its own reviewed release, listed in the
  schema test, made after every host runs a core that stopped using the object.
  An older runtime's readiness check would accept the newer schema, so that
  precondition is the host's release step, not code. Such a release does not roll
  back: an image whose runner predates the record re-applies every file and fails
  on the removed objects.
