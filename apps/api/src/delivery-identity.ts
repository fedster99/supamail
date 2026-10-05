import type { PgPool } from "./db.js";

/**
 * The delivery an `imap_messages` row (alias `m`, body `b`, active assignment
 * `ta`) belongs to; stored copies of one email share it. Copies collapse only
 * on delivery-identity evidence. An active threading assignment is authoritative. During the
 * pre-activation compatibility window we can still safely collapse a provider
 * message id, or an RFC Message-ID paired with the exact complete raw-MIME
 * digest. Everything else remains a distinct physical row rather than risking
 * a false merge.
 *
 * The fallback keys are fixed-size hashes so sorting a hostile provider value
 * cannot create an unbounded PostgreSQL sort key.
 */
export const DELIVERY_KEY_SQL = `coalesce(
  ta.delivery_key,
  CASE
    WHEN nullif(m.provider_message_id_namespace, '') IS NOT NULL
      AND nullif(m.provider_message_id, '') IS NOT NULL
      THEN 'provider:' || encode(extensions.digest(
        m.provider_message_id_namespace || chr(31) || m.provider_message_id,
        'sha256'
      ), 'hex')
    WHEN nullif(m.message_id_normalized, '') IS NOT NULL
      AND b.raw_mime_sha256 IS NOT NULL
      THEN 'rfc-body:' || encode(extensions.digest(
        m.message_id_normalized || chr(31) || b.raw_mime_sha256,
        'sha256'
      ), 'hex')
    ELSE 'physical:' || m.id::text
  END
)`;

/**
 * Each message's active assignment, alias `ta`: at most one row per message,
 * because an account has one active run. The view carries no security barrier
 * (migration 0029), so the planner flattens it and this join takes the
 * message index instead of building the account's whole active projection.
 */
export const ACTIVE_ASSIGNMENT_JOIN = `LEFT JOIN public.imap_thread_active_assignments ta
        ON ta.message_id = m.id
       AND ta.account_id = m.account_id`;

/**
 * The delivery key of each given message: stored copies of one email share
 * one key. Hosts that keep their own search index use this to show one copy.
 */
export async function deliveryKeys(
  db: Pick<PgPool, "query">,
  messageIds: readonly string[]
): Promise<Map<string, string>> {
  if (messageIds.length === 0) return new Map();
  const result = await db.query<{ id: string; delivery_key: string }>(
    `SELECT m.id::text AS id, ${DELIVERY_KEY_SQL} AS delivery_key
     FROM public.imap_messages m
     ${ACTIVE_ASSIGNMENT_JOIN}
     LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
     WHERE m.id = ANY($1::uuid[])`,
    [messageIds]
  );
  return new Map(result.rows.map((row) => [row.id, row.delivery_key]));
}
