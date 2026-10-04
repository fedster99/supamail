const MIRROR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mirror rows (accounts, messages, attachments) are keyed by UUID. Any other value
 * names no row, so a lookup answers "not found" without asking Postgres to cast it,
 * which fails with SQLSTATE 22P02 and would surface as a server error.
 */
export function isMirrorId(value: unknown): value is string {
  return typeof value === "string" && MIRROR_ID_RE.test(value);
}
