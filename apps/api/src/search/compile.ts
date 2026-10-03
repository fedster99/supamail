import type { SearchFilter, SearchSort, TextTerm, TextTerms } from "./types.js";
import type { WindowStatus } from "../types.js";
import { parseTextTerms } from "./parse.js";
import { filenameGlob, filetypeMatch, isRelativeDate, resolveRelativeDate } from "./rules.js";

/** Accumulates bound parameter values and hands back `$n` placeholders. User
 * input is NEVER interpolated into SQL text — only through these placeholders. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export interface CompileOptions {
  accountIds: string[] | null;
  windowStatus: WindowStatus[] | null;
  includeDeleted: boolean;
  sort: SearchSort;
  limit: number;
  offset: number;
  snippet: boolean;
  includeBody: boolean;
  /** Collapse each conversation to its single best message (email-search default). */
  groupByThread: boolean;
  /** Significant query tokens (operators stripped) for the trigram fuzzy branch.
   *  Empty disables fuzzy retrieval. */
  terms: string[];
  /** Curated concept synonyms for the OR-widened semantic branch. Empty disables
   *  concept retrieval. */
  synonyms: string[];
  /** Frozen clock for recency + relative-date filters (ISO timestamp). null uses
   *  SQL `now()` (production); the eval pins it so scorecards are reproducible. */
  now: string | null;
}

export interface CompiledQuery {
  text: string;
  values: unknown[];
}


function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Bind a date filter value as a timestamp. A relative value is resolved by the
 * shared `resolveRelativeDate` from `now` (the frozen eval clock, or compile time). */
function dateExpr(value: string, pb: Params, now: Date): string {
  return `${pb.add(isRelativeDate(value) ? resolveRelativeDate(value, now).toISOString() : value)}::timestamptz`;
}

function filetypePredicate(value: string, pb: Params): string {
  const match = filetypeMatch(value);
  if (match.kind === "prefix") return `lower(a.mime_type) LIKE ${pb.add(`${escapeLike(match.prefix)}%`)}`;
  if (match.kind === "mimes") return `lower(a.mime_type) = ANY(${pb.add(match.mimes)}::text[])`;
  return `lower(a.mime_type) LIKE ${pb.add(`%${escapeLike(match.text)}%`)}`;
}

/**
 * Compile free text with the shared grammar (`parseTextTerms`): groups are ANDed,
 * the terms of a group are ORed, and exclusions are negated. `excluded` matches
 * any excluded term, so callers can drop
 * those messages from every candidate branch, not only the exact match.
 */
function textTsquery({ groups, negative }: TextTerms, pb: Params): { query: string; excluded: string | null } {
  const term = ({ text: value, phrase }: TextTerm): string =>
    `${phrase ? "phraseto_tsquery" : "plainto_tsquery"}('english', public.f_unaccent(${pb.add(value)}))`;
  const any = (terms: string[]): string => terms.length === 1 ? terms[0] : `(${terms.join(" || ")})`;
  const excludedTerms = negative.map(term);
  const parts = [...groups.map((group) => any(group.map(term))), ...excludedTerms.map((excluded) => `!!${excluded}`)];
  return {
    // Text without a searchable word matches nothing, as an empty tsquery always did.
    query: parts.length === 0 ? "plainto_tsquery('english', '')" : parts.length === 1 ? parts[0] : `(${parts.join(" && ")})`,
    excluded: excludedTerms.length === 0 ? null : any(excludedTerms),
  };
}

function filterPredicate(filter: SearchFilter, pb: Params, now: Date): string {
  const negate = (expr: string): string => (("negated" in filter && filter.negated) ? `NOT (${expr})` : expr);

  switch (filter.kind) {
    case "from": {
      const p = pb.add(`%${escapeLike(filter.value)}%`);
      return negate(`(lower(coalesce(m.from_email,'')) LIKE ${p} OR lower(coalesce(m.from_name,'')) LIKE ${p})`);
    }
    case "fromDomain": {
      const p = pb.add(filter.value);
      return negate(`lower(split_part(coalesce(m.from_email,''),'@',2)) = ${p}`);
    }
    case "recipient": {
      const p = pb.add(`%${escapeLike(filter.value)}%`);
      return negate(
        `lower(public.f_array_to_text(coalesce(m.to_emails,'{}'::text[]) || coalesce(m.cc_emails,'{}'::text[]))) LIKE ${p}`
      );
    }
    case "to": {
      const p = pb.add(`%${escapeLike(filter.value)}%`);
      return negate(`lower(public.f_array_to_text(coalesce(m.to_emails,'{}'::text[]))) LIKE ${p}`);
    }
    case "cc": {
      const p = pb.add(`%${escapeLike(filter.value)}%`);
      return negate(`lower(public.f_array_to_text(coalesce(m.cc_emails,'{}'::text[]))) LIKE ${p}`);
    }
    case "bcc": {
      const p = pb.add(`%${escapeLike(filter.value)}%`);
      return negate(`lower(public.f_array_to_text(coalesce(m.bcc_emails,'{}'::text[]))) LIKE ${p}`);
    }
    case "anyEmail": {
      // from + to + cc + bcc, flattened to one lowercased text blob (Nylas any_email).
      const p = pb.add(`%${escapeLike(filter.value)}%`);
      return negate(
        `lower(coalesce(m.from_email,'') || ' ' || public.f_array_to_text(` +
          `coalesce(m.to_emails,'{}'::text[]) || coalesce(m.cc_emails,'{}'::text[]) || ` +
          `coalesce(m.bcc_emails,'{}'::text[]))) LIKE ${p}`
      );
    }
    case "subject": {
      const p = pb.add(`%${escapeLike(filter.value.toLowerCase())}%`);
      return negate(`lower(coalesce(m.subject,'')) LIKE ${p}`);
    }
    case "body": {
      const { query } = textTsquery(parseTextTerms(filter.value), pb);
      const match = `public.imap_search_extract_fts(b.search_extract) @@ ${query}`;
      return filter.negated ? `(b.search_extract IS NULL OR NOT (${match}))` : match;
    }
    case "folder": {
      if (filter.value.endsWith("/*")) {
        const p = pb.add(`${escapeLike(filter.value.slice(0, -2).toLowerCase())}/%`);
        return negate(`lower(m.folder_path) LIKE ${p}`);
      }
      const p = pb.add(filter.value.toLowerCase());
      return negate(`lower(m.folder_path) = ${p}`);
    }
    case "thread": {
      const p = pb.add(filter.value);
      return negate(
        `(m.provider_thread_id = ${p} OR EXISTS (` +
        `SELECT 1 FROM public.imap_thread_active_assignments thread_assignment ` +
        `WHERE thread_assignment.message_id = m.id ` +
        `AND thread_assignment.account_id = m.account_id ` +
        `AND thread_assignment.conversation_id = ${p}))`
      );
    }
    case "msgid": {
      const p = pb.add(filter.value);
      return negate(`m.message_id_normalized = ${p}`);
    }
    case "flag": {
      const p = pb.add(filter.value);
      const has = `coalesce(m.flags,'{}'::text[]) @> ARRAY[${p}]::text[]`;
      return filter.negated ? `NOT (${has})` : has;
    }
    case "hasAttachment": {
      const exists = `EXISTS (SELECT 1 FROM public.imap_attachments a WHERE a.message_id = m.id AND a.disposition = 'attachment')`;
      return filter.negated ? `NOT ${exists}` : exists;
    }
    case "hasBody":
      return filter.negated ? `m.body_fetched_at IS NULL` : `m.body_fetched_at IS NOT NULL`;
    case "filename": {
      // The shared glob, as LIKE: escape LIKE's own wildcards, then map * and ?.
      const like = escapeLike(filenameGlob(filter.value)).replace(/\*/g, "%").replace(/\?/g, "_");
      const p = pb.add(like);
      const exists = `EXISTS (SELECT 1 FROM public.imap_attachments a WHERE a.message_id = m.id AND lower(coalesce(a.filename,'')) LIKE ${p})`;
      return filter.negated ? `NOT ${exists}` : exists;
    }
    case "filetype": {
      const exists = `EXISTS (SELECT 1 FROM public.imap_attachments a WHERE a.message_id = m.id AND ${filetypePredicate(filter.value, pb)})`;
      return filter.negated ? `NOT ${exists}` : exists;
    }
    case "mime": {
      const p = pb.add(filter.value);
      const exists = `EXISTS (SELECT 1 FROM public.imap_attachments a WHERE a.message_id = m.id AND lower(coalesce(a.mime_type,'')) = ${p})`;
      return filter.negated ? `NOT ${exists}` : exists;
    }
    case "date": {
      const op = filter.op === "after" ? ">=" : "<";
      return negate(`m.internal_date ${op} ${dateExpr(filter.value, pb, now)}`);
    }
    case "size": {
      const op = filter.op === "larger" ? ">" : "<";
      return negate(`m.size_bytes ${op} ${pb.add(filter.value)}`);
    }
    case "window": {
      const p = pb.add(filter.value);
      return negate(`m.window_status = ${p}`);
    }
    case "or":
      return negate(`(${filter.filters.map((member) => filterPredicate(member, pb, now)).join(" OR ")})`);
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

function orderClause(sort: SearchSort, hasText: boolean, alias: string): string {
  const a = alias;
  switch (sort) {
    case "smart":
      // is_primary first: every exact (lexical) match ranks above any fuzzy/
      // concept-only match, so the recall branches never reorder exact results.
      return hasText
        ? `${a}.is_primary DESC, (${a}.text_rel * ${a}.recency * ${a}.email_prior) DESC, ${a}.internal_date DESC, ${a}.id DESC`
        : `${a}.internal_date DESC, ${a}.id DESC`;
    case "relevance":
      return hasText
        ? `${a}.is_primary DESC, (${a}.text_rel * ${a}.email_prior) DESC, ${a}.internal_date DESC, ${a}.id DESC`
        : `${a}.internal_date DESC, ${a}.id DESC`;
    case "recent":
      return `${a}.internal_date DESC, ${a}.id DESC`;
    case "oldest":
      return `${a}.internal_date ASC, ${a}.id ASC`;
    case "size":
      return `${a}.size_bytes DESC NULLS LAST, ${a}.id DESC`;
    case "sender":
      return `lower(coalesce(${a}.from_email,'')) ASC, ${a}.internal_date DESC, ${a}.id DESC`;
    default:
      return `${a}.internal_date DESC, ${a}.id DESC`;
  }
}

/**
 * Compile the parsed query into one fully-bound SQL statement. Shape:
 *   cand   -> index-driven candidate rows + lexical ranks
 *   scored -> + recency decay + clamped email-signal prior
 *   page   -> + final score, ORDER BY, LIMIT/OFFSET
 *   outer  -> attachment count + ts_headline snippet (only on the page)
 */
export function compileSearch(
  terms: TextTerms,
  filters: SearchFilter[],
  opts: CompileOptions
): CompiledQuery {
  const pb = new Params();
  // Frozen clock: production passes null → SQL now(); the eval pins an instant so
  // recency and relative-date filters are byte-reproducible run-to-run.
  const nowExpr = opts.now ? `${pb.add(opts.now)}::timestamptz` : "now()";
  // Free text without a searchable word matches nothing; no free text skips the text branch.
  const hasText = terms.hasText;
  const textQuery = hasText ? textTsquery(terms, pb) : { query: null, excluded: null };
  const tsq = textQuery.query;

  const lexHeader = tsq ? `ts_rank_cd(m.header_fts, ${tsq})` : "0";
  const lexBody = tsq
    ? `(CASE WHEN b.search_extract IS NOT NULL THEN ts_rank_cd(public.imap_search_extract_fts(b.search_extract), ${tsq}, 2) ELSE 0 END)`
    : "0";

  // ── Recall branches (RECALL ONLY; ranked strictly below exact matches) ───────
  // Fuzzy (typo): pg_trgm word-similarity over the trigram-indexed columns, so a
  // misspelled query word still retrieves. OPERATOR(extensions.<%) drives the
  // 0007 gin_trgm_ops indexes; the per-statement threshold is set in search.ts.
  // Concept (semantic): an OR-widened tsquery (primary || curated synonyms), so
  // an intent word ("vacation") retrieves mail that never says it literally.
  const fuzzyTerms = hasText && opts.terms.length > 0 ? opts.terms : [];
  const termsP = fuzzyTerms.length > 0 ? pb.add(fuzzyTerms) : null;
  const recipientsText =
    `lower(public.f_array_to_text(coalesce(m.to_emails,'{}'::text[]) || coalesce(m.cc_emails,'{}'::text[])))`;
  // Fuzzy candidate gate: ONE predicate per term as a bound CONSTANT, so each
  // `lower(col) %> term` can use the 0007 gin_trgm_ops index. An unnest()/EXISTS
  // form forces a seq scan (the term isn't a constant the planner can probe with).
  // Columns match the index expressions exactly: lower(subject)/from_name/from_email
  // and the recipients f_array_to_text expression.
  const fuzzyIdGate = fuzzyTerms.length > 0
    ? "(" + fuzzyTerms.map((t) => {
        const p = pb.add(t);
        return `lower(m.subject) OPERATOR(extensions.%>) ${p} ` +
          `OR lower(m.from_name) OPERATOR(extensions.%>) ${p} ` +
          `OR lower(m.from_email) OPERATOR(extensions.%>) ${p} ` +
          `OR ${recipientsText} OPERATOR(extensions.%>) ${p}`;
      }).join("\n    OR ") + ")"
    : null;
  // Fuzzy score for ranking — computed over the BOUNDED candidate set, so unnest is
  // fine here (no index needed).
  const fuzzSim = termsP
    ? `(SELECT coalesce(max(greatest(` +
      `extensions.word_similarity(qt, lower(m.subject)), ` +
      `extensions.word_similarity(qt, lower(m.from_name)))), 0) ` +
      `FROM unnest(${termsP}::text[]) qt)`
    : "0";

  const synonyms = hasText && tsq && opts.synonyms.length > 0 ? opts.synonyms : [];
  const expandedTsq = tsq && synonyms.length > 0
    ? `(${tsq}${synonyms.map((s) => ` || plainto_tsquery('english', public.f_unaccent(${pb.add(s)}))`).join("")})`
    : null;
  const semHeader = expandedTsq ? `ts_rank_cd(m.header_fts, ${expandedTsq})` : "0";
  const semBody = expandedTsq
    ? `(CASE WHEN b.search_extract IS NOT NULL THEN ts_rank_cd(public.imap_search_extract_fts(b.search_extract), ${expandedTsq}, 2) ELSE 0 END)`
    : "0";

  // Non-FTS scoping, applied in EVERY candidate branch so the partial FTS/trigram
  // indexes (which require deleted_in_provider = false) stay usable.
  const scope: string[] = [];
  scope.push(opts.includeDeleted ? "TRUE" : "m.deleted_in_provider = false");
  if (opts.accountIds && opts.accountIds.length > 0) {
    scope.push(`m.account_id = ANY(${pb.add(opts.accountIds)}::uuid[])`);
  }
  if (opts.windowStatus && opts.windowStatus.length > 0) {
    scope.push(`m.window_status = ANY(${pb.add(opts.windowStatus)}::text[])`);
  }
  const scopeSql = scope.join("\n      AND ");
  // Structured operator predicates (from:/folder:/has:/date:…) — applied once over
  // the bounded candidate set (they reference m, the joined body b, or self-contained
  // attachment EXISTS subqueries).
  const now = opts.now ? new Date(opts.now) : new Date();
  const structured = filters.map((filter) => filterPredicate(filter, pb, now));
  // Excluded words drop a message from every branch, including typo and concept recall.
  if (textQuery.excluded) {
    structured.push(
      `NOT (m.header_fts @@ ${textQuery.excluded} OR ` +
      `coalesce(public.imap_search_extract_fts(b.search_extract) @@ ${textQuery.excluded}, false))`
    );
  }

  const limitParam = pb.add(opts.limit + 1);
  const offsetParam = pb.add(opts.offset);

  const snippetExpr = opts.snippet && tsq
    ? `ts_headline('english', public.f_unaccent(coalesce(b2.search_extract, page.subject, '')), ${tsq}, 'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MaxWords=20, MinWords=6, ShortWord=2')`
    : "NULL";
  const bodyExpr = opts.includeBody
    ? "coalesce(b2.body_text, b2.body_plain, b2.selected_text_part)"
    : "NULL";

  // Bulk / mailing-list signal: RFC 2369/2919 list headers, or a clear bulk
  // sender. Used to demote newsletters below human correspondence (but never to
  // hide them — they remain fully retrievable).
  const isListish =
    `(jsonb_exists(m.headers_json, 'list-unsubscribe') ` +
    `OR jsonb_exists(m.headers_json, 'list-id') ` +
    `OR lower(coalesce(m.from_email,'')) ~ '^(newsletter|marketing|mailer)@')`;

  const groupedCte = opts.groupByThread
    ? `,
grouped AS (
  SELECT DISTINCT ON (c.account_id, c.conversation_key) c.*
  FROM counted c
  ORDER BY
    c.account_id,
    c.conversation_key,
    c.is_primary DESC,
    c.score DESC,
    c.internal_date DESC,
    c.id DESC
)`
    : "";
  const pageSource = opts.groupByThread ? "grouped" : "counted";

  const candProjection = `SELECT
    m.id, m.account_id, m.folder_path, m.uidvalidity, m.uid,
    m.subject, m.from_email, m.from_name, m.to_emails, m.flags,
    m.window_status, m.internal_date, m.provider_thread_id, m.body_fetched_at, m.size_bytes,
    ta.conversation_id,
    coalesce(
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
    ) AS delivery_key,
    CASE
      WHEN ta.conversation_id IS NOT NULL
        THEN 'conversation:' || ta.conversation_id
      WHEN m.provider_thread_id IS NOT NULL
        THEN 'provider-thread:' || encode(extensions.digest(
          coalesce(m.provider_thread_id_namespace, 'legacy') || chr(31) || m.provider_thread_id,
          'sha256'
        ), 'hex')
      ELSE 'physical:' || m.id::text
    END AS conversation_key,
    ${isListish} AS is_listish,
    ${lexHeader} AS lex_header,
    ${lexBody} AS lex_body,
    ${fuzzSim} AS fuzz_sim,
    ${semHeader} AS sem_header,
    ${semBody} AS sem_body`;

  // Candidate retrieval. A single OR across imap_messages.header_fts and
  // The header and extract FTS expressions cannot use either GIN across one OR —
  // the planner
  // seq-scans BOTH
  // tables (~23s at 22k rows). Instead collect candidate ids per-index via UNION
  // (header GIN ∪ body GIN ∪ trigram ∪ concept), then hydrate + score the bounded
  // set. With no free text, keep a plain scan: structured predicates use their own
  // b-tree indexes and there is no cross-table FTS OR.
  let candCte: string;
  if (tsq) {
    // Cap each branch's candidate pool by recency. The scorer (ts_rank_cd over
    // extract FTS rank, fuzz_sim, etc.) runs per candidate, so a common/short term that
    // matches thousands of rows would be slow to score even though retrieval is
    // index-fast. A bounded most-recent pool keeps scoring interactive; exact
    // matches are usually few (under the cap) so they are unaffected.
    const cap = (sel: string): string => `(${sel}\n     ORDER BY m.internal_date DESC LIMIT 400)`;
    const idBranches: string[] = [
      cap(`SELECT m.id FROM public.imap_messages m WHERE ${scopeSql} AND m.header_fts @@ ${tsq}`),
      cap(`SELECT bb.message_id AS id FROM public.imap_message_bodies bb JOIN public.imap_messages m ON m.id = bb.message_id WHERE ${scopeSql} AND public.imap_search_extract_fts(bb.search_extract) @@ ${tsq}`)
    ];
    if (fuzzyIdGate) {
      idBranches.push(cap(`SELECT m.id FROM public.imap_messages m WHERE ${scopeSql} AND ${fuzzyIdGate}`));
    }
    if (expandedTsq) {
      idBranches.push(cap(`SELECT m.id FROM public.imap_messages m WHERE ${scopeSql} AND m.header_fts @@ ${expandedTsq}`));
      idBranches.push(cap(`SELECT bb.message_id AS id FROM public.imap_message_bodies bb JOIN public.imap_messages m ON m.id = bb.message_id WHERE ${scopeSql} AND public.imap_search_extract_fts(bb.search_extract) @@ ${expandedTsq}`));
    }
    const candWhere = structured.length > 0 ? `\n  WHERE ${structured.join("\n    AND ")}` : "";
    candCte = `cand_ids AS (
  ${idBranches.join("\n  UNION\n  ")}
),
cand AS (
  ${candProjection}
  FROM public.imap_messages m
  JOIN cand_ids ci ON ci.id = m.id
  LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
  LEFT JOIN public.imap_thread_active_assignments ta
    ON ta.message_id = m.id
   AND ta.account_id = m.account_id${candWhere}
)`;
  } else {
    candCte = `cand AS (
  ${candProjection}
  FROM public.imap_messages m
  LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
  LEFT JOIN public.imap_thread_active_assignments ta
    ON ta.message_id = m.id
   AND ta.account_id = m.account_id
  WHERE ${[...scope, ...structured].join("\n    AND ")}
)`;
  }

  const text = `
WITH ${candCte},
scored AS (
  SELECT
    c.*,
    (c.lex_header > 0 OR c.lex_body > 0) AS is_primary,
    -- Tiered relevance: an exact (primary) lexical match scores on the lexical
    -- weights; a fuzzy/concept-only match scores on its recall signal. is_primary
    -- (the leading ORDER BY key) keeps the two tiers from ever interleaving.
    (CASE WHEN (c.lex_header > 0 OR c.lex_body > 0)
          THEN (0.6 * c.lex_header + 0.2 * c.lex_body)
          ELSE (0.3 * c.fuzz_sim + 0.2 * (0.6 * c.sem_header + 0.2 * c.sem_body))
     END) AS text_rel,
    exp(-0.0231049 * (extract(epoch FROM (${nowExpr} - c.internal_date)) / 86400.0)) AS recency,
    greatest(0.2, least(4.0, 1
      + 0.5 * (CASE WHEN coalesce(c.flags,'{}'::text[]) @> ARRAY['\\Flagged']::text[] THEN 1 ELSE 0 END)
      + 0.3 * (CASE WHEN NOT (coalesce(c.flags,'{}'::text[]) @> ARRAY['\\Seen']::text[]) THEN 1 ELSE 0 END)
      - 0.7 * (CASE WHEN c.is_listish THEN 1 ELSE 0 END)
    )) AS email_prior
  FROM cand c
),
ranked AS (
  SELECT
    s.*,
    (s.text_rel * s.recency * s.email_prior) AS score
  FROM scored s
),
delivery_representatives AS (
  SELECT DISTINCT ON (r.account_id, r.delivery_key) r.*
  FROM ranked r
  ORDER BY
    r.account_id,
    r.delivery_key,
    r.is_primary DESC,
    r.score DESC,
    (r.body_fetched_at IS NOT NULL) DESC,
    r.internal_date DESC,
    r.folder_path ASC,
    r.id ASC
),
counted AS (
  SELECT
    d.*,
    count(*) OVER (PARTITION BY d.account_id, d.conversation_key)::int AS thread_count
  FROM delivery_representatives d
)${groupedCte},
page AS (
  SELECT * FROM ${pageSource} p
  ORDER BY ${orderClause(opts.sort, hasText, "p")}
  LIMIT ${limitParam} OFFSET ${offsetParam}
)
SELECT
  page.id, page.account_id, page.folder_path, page.uidvalidity, page.uid,
  page.subject, page.from_email, page.from_name, page.to_emails, page.flags,
  page.window_status, page.internal_date, page.conversation_id,
  page.provider_thread_id, page.body_fetched_at,
  page.thread_count::int AS thread_count,
  page.text_rel::float8 AS text_rel, page.recency::float8 AS recency,
  page.email_prior::float8 AS email_prior, page.score::float8 AS score,
  (SELECT count(*) FROM public.imap_attachments a
    WHERE a.message_id = page.id AND a.disposition = 'attachment')::int AS attachment_count,
  ${snippetExpr} AS snippet,
  ${bodyExpr} AS body
FROM page
LEFT JOIN public.imap_message_bodies b2 ON b2.message_id = page.id
ORDER BY ${orderClause(opts.sort, hasText, "page")}
`;

  return { text, values: pb.values };
}
