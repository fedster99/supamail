import { extractMessageIdTokens } from "./threading.js";

/**
 * The ONE shared thread-membership walk (CC-3, ADR 0016's thread-identity rule).
 *
 * `read_thread` (the read surface, src/mcp/tools/read-thread.ts) and
 * `resolveThreadTargets` (the write fan-out, mailbox-mutations.ts) both reconstruct
 * "every live message in the thread seeded by a message" using the SAME one-hop
 * References walk. That walk is three things, all of which used to be hand-copied
 * across the two files:
 *   1. strict RFC Message-ID extraction (case-preserving and angle-bracketed),
 *   2. the membership WHERE PREDICATE (provider_thread_id OR id OR an exact
 *      strict Message-ID/In-Reply-To token match), and
 *   3. the ORDER (oldest-first: internal_date ASC, id ASC).
 *
 * They are shared here so the read tool and the mutate fan-out agree on "what is in
 * a thread" BY CONSTRUCTION. Each caller keeps its OWN FROM/JOIN/projection (read
 * needs body + participants, write needs folder + uidvalidity + uid), so this is a
 * shared PREDICATE/token-extraction builder, not one union query — the row source each
 * caller scans is unchanged, only the membership logic is single-sourced.
 *
 * This module is pure SQL fragments + strict token extraction (no IMAP client, no write
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
 * Extract one strict, angle-bracketed RFC Message-ID token. The historical name is
 * retained for source compatibility, but this deliberately does not lowercase or
 * repair malformed input: RFC Message-ID equality is case-sensitive.
 */
export function normalizeIdToken(token: string): string {
  return extractMessageIdTokens(token)[0] ?? "";
}

/**
 * Build the distinct strict id-token key set from a seed row's References,
 * In-Reply-To, and Message-ID fields. `message_id_normalized` is intentionally not
 * used: that legacy cache lowercases the local part and can conflate unrelated IDs.
 */
export function threadSeedKeys(seed: ThreadSeedRow): string[] {
  const keys = new Set<string>();
  for (const value of [seed.references_header, seed.in_reply_to, seed.rfc_message_id]) {
    if (!value) continue;
    for (const token of extractMessageIdTokens(value)) keys.add(token);
  }
  return [...keys];
}

/**
 * The shared membership WHERE predicate + ORDER, parameterized positionally so each
 * caller can slot it into its own SELECT/FROM/JOIN. The bind parameters MUST be, in
 * order: `$1` = account_id, `$2` = provider_thread_id (nullable), `$3` = seed id,
 * `$4` = the strict, case-preserving key array (text[]). `tableAlias` is the prefix for the
 * scanned table's columns ("m" for read_thread's aliased JOIN, "" for the write
 * fan-out's unaliased FROM); pass "" for no alias.
 *
 * Identity rule (ADR 0016): a row is in the thread iff it shares the seed's
 * provider_thread_id, IS the seed, or its exact bracketed Message-ID / In-Reply-To
 * is in the seed's strict key set. The raw comparisons intentionally fail closed
 * on comments, bare IDs, multiple IDs, or other malformed legacy input.
 */
export function threadMembershipClause(tableAlias: string): string {
  const col = tableAlias ? `${tableAlias}.` : "";
  return `${col}account_id = $1
      AND ${col}deleted_in_provider = false
      AND (
        ($2::text IS NOT NULL AND ${col}provider_thread_id = $2)
        OR ${col}id = $3
        OR btrim(${col}rfc_message_id) IN (
          SELECT '<' || strict_id || '>'
          FROM unnest($4::text[]) AS strict_ids(strict_id)
        )
        OR btrim(${col}in_reply_to) IN (
          SELECT '<' || strict_id || '>'
          FROM unnest($4::text[]) AS strict_ids(strict_id)
        )
      )
    ORDER BY ${col}internal_date ASC, ${col}id ASC`;
}
