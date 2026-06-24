import type { ParsedQuery, SearchFilter, SearchSort, StructuredFilters } from "./types.js";
import { SEARCH_SORTS } from "./types.js";
import type { WindowStatus } from "../types.js";
import {
  DATE_FIELDS,
  FLAG_FIELDS,
  SIZE_FIELDS,
  TEXT_FIELDS,
  TEXT_FIELD_BY_OPERATOR,
  WINDOW_STRUCTURED_KEY
} from "./filter-fields.js";

/** The non-table operators: multi-value flag operators, validated date/size
 * operators, and the non-filter output controls. The per-field `field:value`
 * operators are sourced from {@link TEXT_FIELD_BY_OPERATOR} so adding a text
 * field auto-registers it. A `field:value` token whose field is in NEITHER set
 * (e.g. a bare URL like `http://x`) is treated as free text, not an operator. */
const SPECIAL_OPERATORS = [
  "is", "has",
  "after", "since", "newer_than", "newer",
  "before", "until", "older_than", "older",
  "larger", "bigger", "smaller",
  "account", "window", "lane",
  "sort", "limit"
];
const KNOWN_OPERATORS = new Set<string>([
  ...TEXT_FIELD_BY_OPERATOR.keys(),
  ...SPECIAL_OPERATORS
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

/** A date filter value is acceptable iff it is a relative spec (`7d`) or an
 * absolute `YYYY-MM-DD[...]` date. Anything else (e.g. `garbage`) is rejected
 * here so it never reaches `$n::timestamptz`, where Postgres would 500. */
function isValidDate(value: string): boolean {
  return isRelativeDate(value) || ABSOLUTE_DATE.test(value);
}

/** Push a `date` filter for a structured after/before value, or warn+ignore an
 * unparseable one — the same guard the `after:`/`before:` q-operators apply. */
function pushDate(
  op: "after" | "before",
  value: string,
  warnings: string[],
  push: (filter: SearchFilter) => void
): void {
  if (isValidDate(value)) {
    push({ kind: "date", op, value, negated: false, raw: `${op}:${value}` });
  } else {
    warnings.push(`unparseable date "${value}" for ${op}:; ignored`);
  }
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

    // Table-driven text fields (from:/to:/cc:/subject:/in:/filename:/…). The
    // field table single-sources the kind, value-normalization, and value-based
    // routing (the `from:@domain` → fromDomain split), so this one branch
    // replaces what used to be ~15 hand-written operator cases.
    const textField = TEXT_FIELD_BY_OPERATOR.get(field);
    if (textField) {
      const normalized = textField.normalize(rawValue);
      const routed = textField.route ? textField.route(normalized) : { kind: textField.kind, value: normalized };
      filters.push({ kind: routed.kind, value: routed.value, negated, raw } as SearchFilter);
      continue;
    }

    switch (field) {
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
      case "after":
      case "since":
      case "newer_than":
      case "newer": {
        if (isValidDate(rawValue)) {
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
        if (isValidDate(rawValue)) {
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
 * string parser emits, so structured request input and `q` share one compiler.
 * `warnings` collects any ignored input (e.g. an unparseable date) the same way
 * `parseQuery` does, so a bad structured value is dropped — never sent to SQL.
 *
 * Driven by the same {@link TEXT_FIELDS}/{@link FLAG_FIELDS}/{@link DATE_FIELDS}/
 * {@link SIZE_FIELDS} table the operator parser consumes, so the two adapters
 * cannot drift. Iteration order matches the historical hand-written push sequence,
 * so the emitted filter array is byte-identical to before. */
export function filtersFromStructured(structured: StructuredFilters, warnings: string[] = []): SearchFilter[] {
  const out: SearchFilter[] = [];
  const push = (filter: SearchFilter): void => {
    out.push(filter);
  };

  // Text fields: same truthy guard as before (`if (structured.x)`), so an empty
  // string is skipped. `raw` echoes the ORIGINAL (un-normalized) input value.
  for (const field of TEXT_FIELDS) {
    const key = field.structuredKey;
    if (key === undefined) continue; // operator-only lane (recipient)
    const original = structured[key];
    if (typeof original !== "string" || !original) continue;
    const normalized = field.normalize(original);
    const routed = field.route ? field.route(normalized) : { kind: field.kind, value: normalized };
    const raw = field.structuredRaw ? field.structuredRaw(original) : `${field.rawPrefix}:${original}`;
    push({ kind: routed.kind, value: routed.value, negated: false, raw } as SearchFilter);
  }

  // State/presence flags. `honorsFalse` fields emit on an explicit `false` (it
  // inverts, like `hasAttachment:false` = "no attachment"); the rest no-op on a
  // falsy value. The flag token, `negated` polarity, and `raw` come from the table.
  for (const field of FLAG_FIELDS) {
    const value = structured[field.structuredKey];
    if (value === undefined) continue;
    if (!field.honorsFalse && !value) continue;
    push(field.toFilter(value as boolean));
  }

  // Date range. Invalid structured dates are ignored with a warning (parity with
  // the q-operator path) — never passed through to `$n::timestamptz` (Postgres 500).
  for (const field of DATE_FIELDS) {
    const value = structured[field.structuredKey];
    if (value !== undefined) pushDate(field.op, value as string, warnings, push);
  }

  // Size range (bound byte count, no validation — Zod already constrains it).
  for (const field of SIZE_FIELDS) {
    const value = structured[field.structuredKey];
    if (value !== undefined) {
      push({ kind: "size", op: field.op, value: value as number, negated: false, raw: `${field.op}:${value}` });
    }
  }

  if (structured[WINDOW_STRUCTURED_KEY]) {
    push({ kind: "window", value: structured.window as WindowStatus, negated: false, raw: `window:${structured.window}` });
  }
  return out;
}
