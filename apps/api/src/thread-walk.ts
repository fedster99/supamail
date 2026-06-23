/**
 * The ONE shared thread-membership walk (CC-3, ADR 0016's thread-identity rule).
 *
 * `read_thread` (the read surface, src/mcp/tools/read-thread.ts) and
 * `resolveThreadTargets` (the write fan-out, mailbox-mutations.ts) both reconstruct
 * "every live message in the thread seeded by a message" using the SAME one-hop
 * References walk. That walk is three things, all of which used to be hand-copied
 * across the two files:
 *   1. the id-token NORMALIZATION (strip `<>`, lowercase, split on whitespace),
 *   2. the membership WHERE PREDICATE (provider_thread_id OR id OR normalized
 *      Message-Id/In-Reply-To token match), and
 *   3. the ORDER (oldest-first: internal_date ASC, id ASC).
 *
 * They are shared here so the read tool and the mutate fan-out agree on "what is in
 * a thread" BY CONSTRUCTION. Each caller keeps its OWN FROM/JOIN/projection (read
 * needs body + participants, write needs folder + uidvalidity + uid), so this is a
 * shared PREDICATE/normalization builder, not one union query — the row source each
 * caller scans is unchanged, only the membership logic is single-sourced.
 *
 * This module is pure SQL fragments + string normalization (no IMAP client, no write
 * verb), so it is safe to import from the zero-send agent surface
 * (`agent-surface-zero-send.test.ts`).
 */

/** The seed message's threading fields, read once before the membership walk. */
export interface ThreadSeedRow {
  id: string;
  provider_thread_id: string | null;
  rfc_message_id: string | null;
  message_id_normalized: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  account_id: string;
}

/**
 * Normalize one raw Message-Id-ish token: trim, strip surrounding angle brackets,
 * lowercase. Matches the SQL `lower(trim(both '<>' from ...))` used in the predicate
 * so the in-memory key set and the column comparison agree.
 */
export function normalizeIdToken(token: string): string {
  return token.trim().replace(/^<+/, "").replace(/>+$/, "").trim().toLowerCase();
}

/**
 * Build the distinct, normalized id-token key set from a seed row's reference
 * headers (references_header + in_reply_to, each split on whitespace) plus its own
 * rfc_message_id + message_id_normalized, per ADR 0016. Order is not significant
 * (the keys feed `= ANY(...)`).
 */
export function threadSeedKeys(seed: ThreadSeedRow): string[] {
  const raw: string[] = [];
  if (seed.references_header) raw.push(...seed.references_header.split(/\s+/));
  if (seed.in_reply_to) raw.push(...seed.in_reply_to.split(/\s+/));
  if (seed.rfc_message_id) raw.push(seed.rfc_message_id);
  if (seed.message_id_normalized) raw.push(seed.message_id_normalized);
  const keys = new Set<string>();
  for (const token of raw) {
    const normalized = normalizeIdToken(token);
    if (normalized) keys.add(normalized);
  }
  return [...keys];
}

/**
 * The shared membership WHERE predicate + ORDER, parameterized positionally so each
 * caller can slot it into its own SELECT/FROM/JOIN. The bind parameters MUST be, in
 * order: `$1` = account_id, `$2` = provider_thread_id (nullable), `$3` = seed id,
 * `$4` = the normalized key array (text[]). `tableAlias` is the prefix for the
 * scanned table's columns ("m" for read_thread's aliased JOIN, "" for the write
 * fan-out's unaliased FROM); pass "" for no alias.
 *
 * Identity rule (ADR 0016): a row is in the thread iff it shares the seed's
 * provider_thread_id, IS the seed, or its normalized Message-Id / In-Reply-To is in
 * the seed's key set. Oldest-first by internal_date then id.
 */
export function threadMembershipClause(tableAlias: string): string {
  const col = tableAlias ? `${tableAlias}.` : "";
  return `${col}account_id = $1
      AND ${col}deleted_in_provider = false
      AND (
        ($2::text IS NOT NULL AND ${col}provider_thread_id = $2)
        OR ${col}id = $3
        OR ${col}message_id_normalized = ANY($4::text[])
        OR lower(trim(both '<>' from ${col}in_reply_to)) = ANY($4::text[])
      )
    ORDER BY ${col}internal_date ASC, ${col}id ASC`;
}
