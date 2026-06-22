import type { ParsedQuery, SearchFilter, SearchSort, StructuredFilters } from "./types.js";
import { SEARCH_SORTS } from "./types.js";
import type { WindowStatus } from "../types.js";

/** Operator fields we recognize. A `field:value` token whose field is NOT here
 * (e.g. a bare URL like `http://x`) is treated as free text, not an operator. */
const KNOWN_OPERATORS = new Set([
  "from", "to", "cc", "bcc", "recipient", "participant", "with",
  "anyemail", "any_email", "any", "email", "address",
  "subject", "subj", "body",
  "in", "folder", "label",
  "thread", "msgid", "message-id",
  "is", "has",
  "filename", "file", "filetype", "attachment-type", "mime",
  "after", "since", "newer_than", "newer",
  "before", "until", "older_than", "older",
  "larger", "bigger", "smaller",
  "account", "window", "lane",
  "sort", "limit"
]);

const WINDOW_VALUES: WindowStatus[] = ["IN_WINDOW", "EXPIRED", "HISTORICAL"];
const RELATIVE_DATE = /^\d+[hdwmy]$/;
const ABSOLUTE_DATE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;
const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i;

/** Quote-aware tokenizer: whitespace separates tokens, but a double-quoted span
 * is atomic, so `subject:"weekly report"` and `"exact phrase"` stay single
 * tokens. Quotes are preserved in the token for downstream handling. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i])) i += 1;
    if (i >= n) break;
    let token = "";
    let inQuotes = false;
    while (i < n) {
      const ch = input[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
        token += ch;
        i += 1;
        continue;
      }
      if (!inQuotes && /\s/.test(ch)) break;
      token += ch;
      i += 1;
    }
    tokens.push(token);
  }
  return tokens;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/** True when a date value is a relative spec like `7d` / `12h` (resolved to a
 * SQL interval at compile time so this parser stays clock-free and pure). */
export function isRelativeDate(value: string): boolean {
  return RELATIVE_DATE.test(value);
}

function parseSizeToBytes(value: string): number | null {
  const match = SIZE_RE.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] ?? "b").toLowerCase();
  const mult = unit === "kb" ? 1024 : unit === "mb" ? 1024 ** 2 : unit === "gb" ? 1024 ** 3 : 1;
  return Math.round(amount * mult);
}

function mapIsFlag(value: string): SearchFilter | { warning: string } {
  const v = value.toLowerCase();
  switch (v) {
    case "read":
    case "seen":
      return { kind: "flag", value: "\\Seen", negated: false, raw: `is:${value}` };
    case "unread":
    case "unseen":
      return { kind: "flag", value: "\\Seen", negated: true, raw: `is:${value}` };
    case "flagged":
    case "starred":
    case "important":
      return { kind: "flag", value: "\\Flagged", negated: false, raw: `is:${value}` };
    case "answered":
    case "replied":
      return { kind: "flag", value: "\\Answered", negated: false, raw: `is:${value}` };
    case "draft":
      return { kind: "flag", value: "\\Draft", negated: false, raw: `is:${value}` };
    default:
      return { warning: `unknown is:${value} operator; ignored` };
  }
}

/**
 * Parse a free-text superset query into the structured {@link ParsedQuery}.
 * Recognized `field:value` operators become structured filters; everything else
 * is left as free text and handed verbatim to `websearch_to_tsquery`, which
 * natively understands quoted phrases, `or`, and `-` negation. This is total —
 * it never throws; unknown operators are demoted to free text with a warning.
 */
export function parseQuery(input: string): ParsedQuery {
  const filters: SearchFilter[] = [];
  const accounts: string[] = [];
  const warnings: string[] = [];
  const freeTextParts: string[] = [];
  let sort: SearchSort | null = null;
  let limit: number | null = null;

  for (const token of tokenize(input ?? "")) {
    const opMatch = /^(-)?([A-Za-z][\w-]*):([\s\S]*)$/.exec(token);
    const field = opMatch ? opMatch[2].toLowerCase() : null;

    if (!opMatch || field === null || !KNOWN_OPERATORS.has(field)) {
      // Free text (includes bare URLs, `-word` negation, "quoted phrases").
      freeTextParts.push(token);
      continue;
    }

    const negated = opMatch[1] === "-";
    const rawValue = stripQuotes(opMatch[3]).trim();
    const raw = token;

    if (rawValue === "" && field !== "has") {
      warnings.push(`empty value for operator ${field}:; ignored`);
      continue;
    }

    switch (field) {
      case "from": {
        if (rawValue.startsWith("@")) {
          filters.push({ kind: "fromDomain", value: rawValue.slice(1).toLowerCase(), negated, raw });
        } else {
          filters.push({ kind: "from", value: rawValue.toLowerCase(), negated, raw });
        }
        break;
      }
      case "to":
        filters.push({ kind: "to", value: rawValue.toLowerCase(), negated, raw });
        break;
      case "cc":
        filters.push({ kind: "cc", value: rawValue.toLowerCase(), negated, raw });
        break;
      case "bcc":
        filters.push({ kind: "bcc", value: rawValue.toLowerCase(), negated, raw });
        break;
      case "recipient":
      case "participant":
      case "with":
        filters.push({ kind: "recipient", value: rawValue.toLowerCase(), negated, raw });
        break;
      case "anyemail":
      case "any_email":
      case "any":
      case "email":
      case "address":
        filters.push({ kind: "anyEmail", value: rawValue.toLowerCase(), negated, raw });
        break;
      case "subject":
      case "subj":
        filters.push({ kind: "subject", value: rawValue, negated, raw });
        break;
      case "body":
        filters.push({ kind: "body", value: rawValue, negated, raw });
        break;
      case "in":
      case "folder":
      case "label":
        filters.push({ kind: "folder", value: rawValue, negated, raw });
        break;
      case "thread":
        filters.push({ kind: "thread", value: rawValue, negated, raw });
        break;
      case "msgid":
      case "message-id":
        filters.push({ kind: "msgid", value: rawValue, negated, raw });
        break;
      case "is": {
        const mapped = mapIsFlag(rawValue);
        if ("warning" in mapped) warnings.push(mapped.warning);
        else filters.push(negated ? { ...mapped, negated: !mapped.negated } : mapped);
        break;
      }
      case "has": {
        const v = rawValue.toLowerCase();
        if (v === "attachment" || v === "attachments" || v === "file" || v === "") {
          filters.push({ kind: "hasAttachment", negated, raw });
        } else if (v === "noattachment" || v === "noattachments") {
          filters.push({ kind: "hasAttachment", negated: !negated, raw });
        } else if (v === "body") {
          filters.push({ kind: "hasBody", negated, raw });
        } else {
          warnings.push(`unknown has:${rawValue} operator; ignored`);
        }
        break;
      }
      case "filename":
      case "file":
        filters.push({ kind: "filename", value: rawValue.toLowerCase(), negated, raw });
        break;
      case "filetype":
      case "attachment-type":
        filters.push({ kind: "filetype", value: rawValue.toLowerCase(), negated, raw });
        break;
      case "mime":
        filters.push({ kind: "mime", value: rawValue.toLowerCase(), negated, raw });
        break;
      case "after":
      case "since":
      case "newer_than":
      case "newer": {
        if (isRelativeDate(rawValue) || ABSOLUTE_DATE.test(rawValue)) {
          filters.push({ kind: "date", op: "after", value: rawValue, negated, raw });
        } else {
          warnings.push(`unparseable date "${rawValue}" for ${field}:; ignored`);
        }
        break;
      }
      case "before":
      case "until":
      case "older_than":
      case "older": {
        if (isRelativeDate(rawValue) || ABSOLUTE_DATE.test(rawValue)) {
          filters.push({ kind: "date", op: "before", value: rawValue, negated, raw });
        } else {
          warnings.push(`unparseable date "${rawValue}" for ${field}:; ignored`);
        }
        break;
      }
      case "larger":
      case "bigger":
      case "smaller": {
        const bytes = parseSizeToBytes(rawValue);
        if (bytes === null) {
          warnings.push(`unparseable size "${rawValue}" for ${field}:; ignored`);
        } else {
          filters.push({ kind: "size", op: field === "smaller" ? "smaller" : "larger", value: bytes, negated, raw });
        }
        break;
      }
      case "account":
        accounts.push(rawValue);
        break;
      case "window":
      case "lane": {
        const upper = rawValue.toUpperCase() as WindowStatus;
        if (WINDOW_VALUES.includes(upper)) {
          filters.push({ kind: "window", value: upper, negated, raw });
        } else {
          warnings.push(`unknown window/lane "${rawValue}"; ignored`);
        }
        break;
      }
      case "sort": {
        const candidate = rawValue.toLowerCase();
        const aliased = candidate === "date" ? "recent" : candidate;
        if ((SEARCH_SORTS as string[]).includes(aliased)) sort = aliased as SearchSort;
        else warnings.push(`unknown sort "${rawValue}"; ignored`);
        break;
      }
      case "limit": {
        const parsed = Number.parseInt(rawValue, 10);
        if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(parsed, 100);
        else warnings.push(`invalid limit "${rawValue}"; ignored`);
        break;
      }
      default:
        freeTextParts.push(token);
    }
  }

  return {
    freeText: freeTextParts.join(" ").trim(),
    accounts,
    filters,
    sort,
    limit,
    warnings
  };
}

/** Map a typed {@link StructuredFilters} object onto the same filter union the
 * string parser emits, so structured request input and `q` share one compiler. */
export function filtersFromStructured(structured: StructuredFilters): SearchFilter[] {
  const out: SearchFilter[] = [];
  const push = (filter: SearchFilter): void => {
    out.push(filter);
  };
  if (structured.from) {
    const v = structured.from.toLowerCase();
    if (v.startsWith("@")) push({ kind: "fromDomain", value: v.slice(1), negated: false, raw: `from:${structured.from}` });
    else push({ kind: "from", value: v, negated: false, raw: `from:${structured.from}` });
  }
  if (structured.fromDomain) {
    push({ kind: "fromDomain", value: structured.fromDomain.toLowerCase().replace(/^@/, ""), negated: false, raw: `from:@${structured.fromDomain}` });
  }
  if (structured.to) push({ kind: "to", value: structured.to.toLowerCase(), negated: false, raw: `to:${structured.to}` });
  if (structured.cc) push({ kind: "cc", value: structured.cc.toLowerCase(), negated: false, raw: `cc:${structured.cc}` });
  if (structured.bcc) push({ kind: "bcc", value: structured.bcc.toLowerCase(), negated: false, raw: `bcc:${structured.bcc}` });
  if (structured.anyEmail) push({ kind: "anyEmail", value: structured.anyEmail.toLowerCase(), negated: false, raw: `anyemail:${structured.anyEmail}` });
  if (structured.subject) push({ kind: "subject", value: structured.subject, negated: false, raw: `subject:${structured.subject}` });
  if (structured.body) push({ kind: "body", value: structured.body, negated: false, raw: `body:${structured.body}` });
  if (structured.folder) push({ kind: "folder", value: structured.folder, negated: false, raw: `in:${structured.folder}` });
  if (structured.thread) push({ kind: "thread", value: structured.thread, negated: false, raw: `thread:${structured.thread}` });
  if (structured.msgid) push({ kind: "msgid", value: structured.msgid, negated: false, raw: `msgid:${structured.msgid}` });
  if (structured.filename) push({ kind: "filename", value: structured.filename.toLowerCase(), negated: false, raw: `filename:${structured.filename}` });
  if (structured.filetype) push({ kind: "filetype", value: structured.filetype.toLowerCase(), negated: false, raw: `filetype:${structured.filetype}` });
  if (structured.mime) push({ kind: "mime", value: structured.mime.toLowerCase(), negated: false, raw: `mime:${structured.mime}` });
  if (structured.isUnread) push({ kind: "flag", value: "\\Seen", negated: true, raw: "is:unread" });
  if (structured.isRead) push({ kind: "flag", value: "\\Seen", negated: false, raw: "is:read" });
  if (structured.isFlagged) push({ kind: "flag", value: "\\Flagged", negated: false, raw: "is:flagged" });
  if (structured.isStarred) push({ kind: "flag", value: "\\Flagged", negated: false, raw: "is:starred" });
  if (structured.isAnswered) push({ kind: "flag", value: "\\Answered", negated: false, raw: "is:answered" });
  if (structured.isDraft) push({ kind: "flag", value: "\\Draft", negated: false, raw: "is:draft" });
  if (structured.hasAttachment !== undefined) push({ kind: "hasAttachment", negated: !structured.hasAttachment, raw: "has:attachment" });
  if (structured.hasBody !== undefined) push({ kind: "hasBody", negated: !structured.hasBody, raw: "has:body" });
  if (structured.after) push({ kind: "date", op: "after", value: structured.after, negated: false, raw: `after:${structured.after}` });
  if (structured.before) push({ kind: "date", op: "before", value: structured.before, negated: false, raw: `before:${structured.before}` });
  if (structured.largerThan !== undefined) push({ kind: "size", op: "larger", value: structured.largerThan, negated: false, raw: `larger:${structured.largerThan}` });
  if (structured.smallerThan !== undefined) push({ kind: "size", op: "smaller", value: structured.smallerThan, negated: false, raw: `smaller:${structured.smallerThan}` });
  if (structured.window) push({ kind: "window", value: structured.window, negated: false, raw: `window:${structured.window}` });
  return out;
}
