import type { SearchFilter, SearchSort } from "./types.js";
import type { WindowStatus } from "../types.js";
import { isRelativeDate } from "./parse.js";

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
  hasText: boolean;
  limit: number;
  offset: number;
  snippet: boolean;
  includeBody: boolean;
  /** Collapse each conversation to its single best message (email-search default). */
  groupByThread: boolean;
}

export interface CompiledQuery {
  text: string;
  values: unknown[];
}

const RELATIVE_UNIT: Record<string, string> = {
  h: "1 hour",
  d: "1 day",
  w: "1 week",
  m: "1 month",
  y: "1 year"
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Resolve a date filter value to a SQL timestamp expression. Relative values
 * (`7d`) become `now() - (n * interval '1 day')` so the parser stays clock-free;
 * absolute values are bound and cast. */
function dateExpr(value: string, pb: Params): string {
  if (isRelativeDate(value)) {
    const amount = Number.parseInt(value.slice(0, -1), 10);
    const unit = RELATIVE_UNIT[value.slice(-1)] ?? "1 day";
    return `(now() - (${pb.add(amount)} * interval '${unit}'))`;
  }
  return `${pb.add(value)}::timestamptz`;
}

function filetypePredicate(value: string, pb: Params): string {
  switch (value) {
    case "pdf":
      return `lower(a.mime_type) = 'application/pdf'`;
    case "image":
      return `lower(a.mime_type) LIKE 'image/%'`;
    case "video":
      return `lower(a.mime_type) LIKE 'video/%'`;
    case "audio":
      return `lower(a.mime_type) LIKE 'audio/%'`;
    case "text":
      return `lower(a.mime_type) LIKE 'text/%'`;
    case "zip":
    case "archive":
      return `lower(a.mime_type) IN ('application/zip','application/x-zip-compressed','application/gzip','application/x-tar','application/x-7z-compressed')`;
    case "doc":
    case "word":
      return `lower(a.mime_type) IN ('application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document')`;
    case "sheet":
    case "spreadsheet":
    case "excel":
      return `lower(a.mime_type) IN ('application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')`;
    default: {
      const p = pb.add(`%${escapeLike(value)}%`);
      return `lower(a.mime_type) LIKE ${p}`;
    }
  }
}

function filterPredicate(filter: SearchFilter, pb: Params): string {
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
    case "subject": {
      const p = pb.add(`%${escapeLike(filter.value.toLowerCase())}%`);
      return negate(`lower(coalesce(m.subject,'')) LIKE ${p}`);
    }
    case "body": {
      const p = pb.add(filter.value);
      const match = `b.body_fts @@ websearch_to_tsquery('english', public.f_unaccent(${p}))`;
      return filter.negated ? `(b.body_fts IS NULL OR NOT (${match}))` : match;
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
      return negate(`m.provider_thread_id = ${p}`);
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
      const glob = filter.value.replace(/[\\%_]/g, (ch) => `\\${ch}`).replace(/\*/g, "%").replace(/\?/g, "_");
      const p = pb.add(glob.includes("%") || glob.includes("_") ? glob : `%${glob}%`);
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
      return negate(`m.internal_date ${op} ${dateExpr(filter.value, pb)}`);
    }
    case "size": {
      const op = filter.op === "larger" ? ">" : "<";
      return negate(`m.size_bytes ${op} ${pb.add(filter.value)}`);
    }
    case "window": {
      const p = pb.add(filter.value);
      return negate(`m.window_status = ${p}`);
    }
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
      return hasText
        ? `(${a}.text_rel * ${a}.recency * ${a}.email_prior) DESC, ${a}.internal_date DESC, ${a}.id DESC`
        : `${a}.internal_date DESC, ${a}.id DESC`;
    case "relevance":
      return hasText
        ? `(${a}.text_rel * ${a}.email_prior) DESC, ${a}.internal_date DESC, ${a}.id DESC`
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
  freeText: string,
  filters: SearchFilter[],
  opts: CompileOptions
): CompiledQuery {
  const pb = new Params();
  const hasText = opts.hasText && freeText.trim() !== "";
  const qParam = hasText ? pb.add(freeText) : null;
  const tsq = qParam ? `websearch_to_tsquery('english', public.f_unaccent(${qParam}))` : null;

  const lexHeader = tsq ? `ts_rank_cd(m.header_fts, ${tsq})` : "0";
  const lexBody = tsq
    ? `(CASE WHEN b.body_fts IS NOT NULL THEN ts_rank_cd(b.body_fts, ${tsq}, 2) ELSE 0 END)`
    : "0";

  const where: string[] = [];
  where.push(opts.includeDeleted ? "TRUE" : "m.deleted_in_provider = false");
  if (opts.accountIds && opts.accountIds.length > 0) {
    where.push(`m.account_id = ANY(${pb.add(opts.accountIds)}::uuid[])`);
  }
  if (opts.windowStatus && opts.windowStatus.length > 0) {
    where.push(`m.window_status = ANY(${pb.add(opts.windowStatus)}::text[])`);
  }
  if (tsq) {
    where.push(`(m.header_fts @@ ${tsq} OR b.body_fts @@ ${tsq})`);
  }
  for (const filter of filters) {
    where.push(filterPredicate(filter, pb));
  }

  const limitParam = pb.add(opts.limit + 1);
  const offsetParam = pb.add(opts.offset);

  const snippetExpr = opts.snippet && tsq
    ? `ts_headline('english', public.f_unaccent(left(coalesce(b2.body_text, b2.body_plain, b2.selected_text_part, page.subject, ''), 131072)), ${tsq}, 'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MaxWords=20, MinWords=6, ShortWord=2')`
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
  SELECT DISTINCT ON (r.thread_key) r.*
  FROM ranked r
  ORDER BY r.thread_key, r.score DESC, r.internal_date DESC, r.id DESC
)`
    : "";
  const pageSource = opts.groupByThread ? "grouped" : "ranked";

  const text = `
WITH cand AS (
  SELECT
    m.id, m.account_id, m.folder_path, m.uidvalidity, m.uid,
    m.subject, m.from_email, m.from_name, m.to_emails, m.flags,
    m.window_status, m.internal_date, m.provider_thread_id, m.body_fetched_at, m.size_bytes,
    ${isListish} AS is_listish,
    ${lexHeader} AS lex_header,
    ${lexBody} AS lex_body
  FROM public.imap_messages m
  LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
  WHERE ${where.join("\n    AND ")}
),
scored AS (
  SELECT
    c.*,
    (0.6 * c.lex_header + 0.2 * c.lex_body) AS text_rel,
    exp(-0.0231049 * (extract(epoch FROM (now() - c.internal_date)) / 86400.0)) AS recency,
    greatest(0.2, least(4.0, 1
      + 0.5 * (CASE WHEN coalesce(c.flags,'{}'::text[]) @> ARRAY['\\Flagged']::text[] THEN 1 ELSE 0 END)
      + 0.3 * (CASE WHEN NOT (coalesce(c.flags,'{}'::text[]) @> ARRAY['\\Seen']::text[]) THEN 1 ELSE 0 END)
      - 0.7 * (CASE WHEN c.is_listish THEN 1 ELSE 0 END)
    )) AS email_prior,
    count(*) OVER (PARTITION BY coalesce(c.provider_thread_id, c.id::text))::int AS thread_count
  FROM cand c
),
ranked AS (
  SELECT
    s.*,
    (s.text_rel * s.recency * s.email_prior) AS score,
    coalesce(s.provider_thread_id, s.id::text) AS thread_key
  FROM scored s
)${groupedCte},
page AS (
  SELECT * FROM ${pageSource} p
  ORDER BY ${orderClause(opts.sort, hasText, "p")}
  LIMIT ${limitParam} OFFSET ${offsetParam}
)
SELECT
  page.id, page.account_id, page.folder_path, page.uidvalidity, page.uid,
  page.subject, page.from_email, page.from_name, page.to_emails, page.flags,
  page.window_status, page.internal_date, page.provider_thread_id, page.body_fetched_at,
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
