/** Public migration ids are a four-digit sequence, an underscore, and a name. */
const PUBLIC_MIGRATION_ID = /^(\d{4})_\S+$/;

/**
 * Migrations after this one are held additive by the schema test, so an older
 * runtime keeps working on a schema that includes them. Earlier migrations
 * predate the rule (0005 recreates a view with other columns, 0003 replaces a
 * check), so a runtime that requires one of them accepts an exact match only.
 */
export const ADDITIVE_SINCE_SEQUENCE = 29;

/** A migration id's position in manifest order, or null when it is not an id. */
export function publicMigrationSequence(id: string): number | null {
  const match = PUBLIC_MIGRATION_ID.exec(id);
  return match ? Number(match[1]) : null;
}

/** The runtime's own required version is not a public migration id. */
export class InvalidSchemaVersionError extends TypeError {
  constructor(version: string) {
    super(`required schema version is not a public migration id: ${JSON.stringify(version)}`);
    this.name = "InvalidSchemaVersionError";
  }
}

/** The runtime's required version, parsed once; throws when it is not an id. */
export interface RequiredSchemaVersion {
  id: string;
  sequence: number;
}

export function parseRequiredSchemaVersion(requiredSchemaVersion: string): RequiredSchemaVersion {
  const sequence = publicMigrationSequence(requiredSchemaVersion);
  if (sequence === null) throw new InvalidSchemaVersionError(requiredSchemaVersion);
  return { id: requiredSchemaVersion, sequence };
}

/**
 * Whether a runtime that requires `requiredSchemaVersion` can run against a
 * schema at `currentSchemaVersion`. Ids order by their four-digit prefix. A
 * schema behind the runtime is not ready: the code would miss what a later
 * migration adds. A schema at the required sequence must be the required id;
 * two branches can each add a migration with one number. A schema ahead of
 * the runtime is ready from {@link ADDITIVE_SINCE_SEQUENCE} on: later
 * migrations are additive, so an older runtime keeps working, and a host
 * applies a migration before it deploys the runtime that needs it. What is
 * ahead cannot be checked by name; the host's marker is trusted. A missing or
 * malformed schema version is not ready; a malformed required version is the
 * runtime's own error and throws.
 */
export function isSchemaVersionReady(currentSchemaVersion: string, requiredSchemaVersion: string): boolean {
  return schemaServes(currentSchemaVersion, parseRequiredSchemaVersion(requiredSchemaVersion));
}

export function schemaServes(currentSchemaVersion: string, required: RequiredSchemaVersion): boolean {
  const current = publicMigrationSequence(currentSchemaVersion);
  if (current === null) return false;
  if (current === required.sequence) return currentSchemaVersion === required.id;
  return current > required.sequence && required.sequence >= ADDITIVE_SINCE_SEQUENCE;
}
