/** Public migration ids are a four-digit sequence, an underscore, and a name. */
export const PUBLIC_MIGRATION_ID = /^(\d{4})_\S+$/;

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

/** Throws when the runtime's required version is not a public migration id. */
export function assertRequiredSchemaVersion(requiredSchemaVersion: string): void {
  if (publicMigrationSequence(requiredSchemaVersion) === null) {
    throw new InvalidSchemaVersionError(requiredSchemaVersion);
  }
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
  assertRequiredSchemaVersion(requiredSchemaVersion);
  const required = publicMigrationSequence(requiredSchemaVersion)!;
  const current = publicMigrationSequence(currentSchemaVersion);
  if (current === null) return false;
  if (current === required) return currentSchemaVersion === requiredSchemaVersion;
  return current > required && required >= ADDITIVE_SINCE_SEQUENCE;
}

const SQL_COMMENT = /--[^\n]*|\/\*[\s\S]*?\*\//g;
const IDENTIFIER = String.raw`(?:"[^"]*"|\S+)`;

/**
 * Statements that take something away from a running older runtime, or make
 * one of its writes fail. The list is what a scan can see; a replaced function
 * or view body is for review to judge. Returns the first offending statement
 * fragment, or null.
 */
export function findNonAdditiveStatement(sql: string): string | null {
  const text = sql.replace(SQL_COMMENT, " ");
  const patterns = [
    /\bdrop\s+(?:table|index|policy|trigger|type)\b/i,
    // ALTER TABLE ... DROP [COLUMN] name and ... DROP DEFAULT take something
    // away; DROP CONSTRAINT and DROP NOT NULL only loosen.
    new RegExp(String.raw`\balter\s+table\b[^;]*\bdrop\s+(?!constraint\b|not\s+null\b)(?:if\s+exists\s+)?${IDENTIFIER}`, "i"),
    /\brename\b/i,
    new RegExp(String.raw`\balter\s+(?:column\s+)?${IDENTIFIER}\s+(?:(?:set\s+data\s+)?type|set\s+not\s+null)\b`, "i"),
    new RegExp(String.raw`\badd\s+(?:constraint\s+${IDENTIFIER}\s+)?(?:check|unique|primary\s+key|foreign\s+key|exclude)\b`, "i"),
    /\bcreate\s+unique\s+index\b/i,
    /\badd\s+column\s+[^,;]*\bnot\s+null\b(?![^,;]*\bdefault\b)/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}
