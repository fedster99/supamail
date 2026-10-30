import type { PgPool } from "./db.js";

const RFC_BODY_KEY_SQL = `'rfc-body:' || encode(extensions.digest(
  m.message_id_normalized || chr(31) || b.raw_mime_sha256, 'sha256'
), 'hex')`;

// Both joined readers and candidate lookups use the same identity precedence.
// A missing raw digest makes RFC_BODY_KEY_SQL NULL, retaining the physical row.
function deliveryKeySql(activeKey: string, rfcBodyKey: string): string {
  return `coalesce(
    ${activeKey},
    CASE
      WHEN nullif(m.provider_message_id_namespace, '') IS NOT NULL
        AND nullif(m.provider_message_id, '') IS NOT NULL
        THEN 'provider:' || encode(extensions.digest(
          m.provider_message_id_namespace || chr(31) || m.provider_message_id,
          'sha256'
        ), 'hex')
      WHEN nullif(m.message_id_normalized, '') IS NOT NULL
        THEN ${rfcBodyKey}
    END,
    'physical:' || m.id::text
  )`;
}

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
export const DELIVERY_KEY_SQL = deliveryKeySql("ta.delivery_key", RFC_BODY_KEY_SQL);

/**
 * Each message's active assignment, alias `ta`: at most one row per message,
 * because an account has one active run. The view carries no security barrier
 * (migration 0029), so the planner can flatten it and use message indexes.
 * Large candidate sets can still select a mailbox-wide projection plan.
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
  // Scalar subqueries keep assignment lookup correlated to each candidate.
  // CASE/COALESCE read a body digest only without an active or provider key.
  // One statement retains the same snapshot and the caller's RLS policies.
  const keySql = deliveryKeySql(
    `(SELECT ta.delivery_key FROM public.imap_thread_active_assignments ta
      WHERE ta.message_id = m.id AND ta.account_id = m.account_id)`,
    `(SELECT ${RFC_BODY_KEY_SQL} FROM public.imap_message_bodies b
      WHERE b.message_id = m.id)`
  );
  const result = await db.query<{ id: string; delivery_key: string }>(
    `SELECT m.id::text AS id, ${keySql} AS delivery_key
     FROM public.imap_messages m
     WHERE m.id = ANY($1::uuid[])`,
    [messageIds]
  );
  return new Map(result.rows.map((row) => [row.id, row.delivery_key]));
}
