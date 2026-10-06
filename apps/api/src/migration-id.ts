/** Public migration ids are a four-digit sequence, an underscore, and a name. */
const PUBLIC_MIGRATION_ID = /^(\d{4})_\S+$/;

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

/** The sequence of the runtime's required version; throws when it is not an id. */
export function requiredMigrationSequence(requiredSchemaVersion: string): number {
  const sequence = publicMigrationSequence(requiredSchemaVersion);
  if (sequence === null) throw new InvalidSchemaVersionError(requiredSchemaVersion);
  return sequence;
}

/**
 * Whether a runtime that requires `requiredSchemaVersion` can run against a
 * schema at `currentSchemaVersion`. Ids order by their four-digit prefix. A
 * schema behind the runtime is not ready: the code would miss what a later
 * migration adds. A schema ahead of the runtime is ready: public migrations
 * are additive and idempotent, so an older runtime keeps working, and a host
 * applies a migration before it deploys the runtime that needs it. A missing
 * or malformed schema version is not ready; a malformed required version is
 * the runtime's own error and throws.
 */
export function isSchemaVersionReady(currentSchemaVersion: string, requiredSchemaVersion: string): boolean {
  return isSchemaAtOrAfter(currentSchemaVersion, requiredMigrationSequence(requiredSchemaVersion));
}

export function isSchemaAtOrAfter(currentSchemaVersion: string, requiredSequence: number): boolean {
  const current = publicMigrationSequence(currentSchemaVersion);
  return current !== null && current >= requiredSequence;
}
