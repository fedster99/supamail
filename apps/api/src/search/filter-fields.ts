import type { SearchFilter } from "./types.js";

/**
 * The single declarative source of truth for the search filter FIELD set.
 *
 * The per-field mapping used to be encoded three times: the `field:value`
 * operator switch in `parseQuery`, the `if (structured.x)` push sequence in
 * `filtersFromStructured`, and the Zod `searchFiltersSchema` field set in
 * `mcp-tool.ts` (plus the hand-written JSON-Schema literal, guarded by the #40
 * parity test). Adding one filter meant four coordinated edits.
 *
 * This table single-sources the per-field rules. `parseQuery` looks an operator
 * alias up here and applies the entry's normalization; `filtersFromStructured`
 * iterates the entries by their structured key; the Zod field set and the
 * JSON-Schema `filters.properties` key set are both validated against this table
 * by `search-schema-parity.test.ts`. Both adapters still produce the EXACT same
 * `SearchFilter` union values as before — this is a behavior-preserving refactor.
 *
 * What is intentionally NOT table-driven (kept bespoke in `parseQuery`, because
 * each is multi-valued, validated, or not a single-field filter): the `is:` /
 * `has:` multi-value flag operators, the validated `after:`/`before:` date and
 * `larger:`/`smaller:` size operators, and the non-filter operators `account:`,
 * `window:`/`lane:`, `sort:`, `limit:`. Their STRUCTURED twins still live in the
 * table (so the schema key set stays single-sourced); only their q-operator
 * parsing is special-cased.
 */

/** Value-normalization applied to a stripped operator/structured value. */
type Normalize = (value: string) => string;

const lower: Normalize = (v) => v.toLowerCase();
const identity: Normalize = (v) => v;

/**
 * A TEXT field: an operator (and/or structured key) that maps a string value to
 * one `SearchFilter` of a fixed `kind` after a normalization pass. `route` lets a
 * field (today only `from`) redirect to a different kind based on the value (the
 * `@domain` → `fromDomain` split) — it receives the ALREADY-normalized value.
 */
export interface TextFieldRule {
  /** Canonical structured-object key + Zod key. `undefined` = operator-only. */
  structuredKey?: keyof StructuredKeySet;
  /** Default `SearchFilter` kind this field emits. */
  kind: TextFilterKind;
  /** `q:` operator aliases that route here (lowercased). */
  operators: string[];
  /** Value transform (lowercase / identity / strip-leading-@). */
  normalize: Normalize;
  /** Prefix used to synthesize the echoed `raw` from the structured path:
   *  `${rawPrefix}:${originalValue}`. Ignored when `structuredRaw` is set. */
  rawPrefix: string;
  /** Optional value-dependent redirect (the `from:@domain` → fromDomain split). */
  route?: (normalized: string) => { kind: TextFilterKind; value: string };
  /** Optional override for the echoed structured `raw` (the `from:@<domain>`
   *  shape for the structured-only `fromDomain` field). Receives the ORIGINAL
   *  (un-normalized) input value, matching the historical structured emission. */
  structuredRaw?: (original: string) => string;
}

/** The `SearchFilter` kinds that carry a `value: string` (the text fields). */
type TextFilterKind =
  | "from"
  | "fromDomain"
  | "recipient"
  | "to"
  | "cc"
  | "bcc"
  | "anyEmail"
  | "subject"
  | "body"
  | "folder"
  | "thread"
  | "msgid"
  | "filename"
  | "filetype"
  | "mime";

/**
 * The text (string-valued) filter fields. Order matters only for the structured
 * iteration: it matches the historical `filtersFromStructured` push order so the
 * emitted filter array is byte-identical (the order is asserted by tests that read
 * by kind, but we keep it stable regardless).
 */
export const TEXT_FIELDS: TextFieldRule[] = [
  {
    structuredKey: "from",
    kind: "from",
    operators: ["from"],
    normalize: lower,
    rawPrefix: "from",
    // `from:@acme.com` (operator) / `from: "@acme.com"` (structured) → domain lane.
    route: (v) => (v.startsWith("@") ? { kind: "fromDomain", value: v.slice(1) } : { kind: "from", value: v })
  },
  {
    structuredKey: "fromDomain",
    kind: "fromDomain",
    operators: [],
    // Structured `fromDomain` lowercases then strips a leading `@`. The echoed raw
    // is `from:@<original value>` to match the historical structured emission.
    normalize: (v) => v.toLowerCase().replace(/^@/, ""),
    rawPrefix: "from",
    structuredRaw: (original) => `from:@${original}`
  },
  { structuredKey: "to", kind: "to", operators: ["to"], normalize: lower, rawPrefix: "to" },
  { structuredKey: "cc", kind: "cc", operators: ["cc"], normalize: lower, rawPrefix: "cc" },
  { structuredKey: "bcc", kind: "bcc", operators: ["bcc"], normalize: lower, rawPrefix: "bcc" },
  {
    // Broad To+Cc lane: operator-only (no structured twin), kept for back-compat.
    kind: "recipient",
    operators: ["recipient", "participant", "with"],
    normalize: lower,
    rawPrefix: "recipient"
  },
  {
    structuredKey: "anyEmail",
    kind: "anyEmail",
    operators: ["anyemail", "any_email", "any", "email", "address"],
    normalize: lower,
    rawPrefix: "anyemail"
  },
  { structuredKey: "subject", kind: "subject", operators: ["subject", "subj"], normalize: identity, rawPrefix: "subject" },
  { structuredKey: "body", kind: "body", operators: ["body"], normalize: identity, rawPrefix: "body" },
  { structuredKey: "folder", kind: "folder", operators: ["in", "folder", "label"], normalize: identity, rawPrefix: "in" },
  { structuredKey: "thread", kind: "thread", operators: ["thread"], normalize: identity, rawPrefix: "thread" },
  { structuredKey: "msgid", kind: "msgid", operators: ["msgid", "message-id"], normalize: identity, rawPrefix: "msgid" },
  { structuredKey: "filename", kind: "filename", operators: ["filename", "file"], normalize: lower, rawPrefix: "filename" },
  { structuredKey: "filetype", kind: "filetype", operators: ["filetype", "attachment-type"], normalize: lower, rawPrefix: "filetype" },
  { structuredKey: "mime", kind: "mime", operators: ["mime"], normalize: lower, rawPrefix: "mime" }
];

/**
 * A FLAG field: a structured boolean that maps to a `\Seen`/`\Flagged`/… flag
 * predicate or a `hasAttachment`/`hasBody` presence predicate. Each declares its
 * truthiness contract and how the boolean maps to `negated` + `raw`, exactly
 * reproducing the historical `filtersFromStructured` flag block.
 */
export interface FlagFieldRule {
  structuredKey: keyof StructuredKeySet;
  /** `true` honors an explicit `false` (it inverts); `false` no-ops on a falsy value. */
  honorsFalse: boolean;
  /** Build the `SearchFilter` from the (already true/false) boolean value. */
  toFilter: (value: boolean) => SearchFilter;
}

const flag = (flagValue: string, negated: boolean, raw: string): SearchFilter => ({
  kind: "flag",
  value: flagValue,
  negated,
  raw
});

/**
 * The boolean state / presence filter fields, in historical structured order.
 * The `\Seen`/`\Flagged`/… tokens, the `negated` polarity, the `raw` echo, and
 * the honors-false contract are each copied verbatim from the old push block.
 */
export const FLAG_FIELDS: FlagFieldRule[] = [
  // unread honors false: true → unread (negated Seen), false → read (Seen present).
  { structuredKey: "isUnread", honorsFalse: true, toFilter: (v) => flag("\\Seen", v, `is:${v ? "unread" : "read"}`) },
  { structuredKey: "isRead", honorsFalse: false, toFilter: () => flag("\\Seen", false, "is:read") },
  { structuredKey: "isFlagged", honorsFalse: false, toFilter: () => flag("\\Flagged", false, "is:flagged") },
  // starred honors false: false → not-starred (negated Flagged).
  { structuredKey: "isStarred", honorsFalse: true, toFilter: (v) => flag("\\Flagged", !v, `is:${v ? "starred" : "unstarred"}`) },
  { structuredKey: "isAnswered", honorsFalse: false, toFilter: () => flag("\\Answered", false, "is:answered") },
  { structuredKey: "isDraft", honorsFalse: false, toFilter: () => flag("\\Draft", false, "is:draft") },
  // hasAttachment/hasBody honor false (false → "no attachment"/"no body", negated).
  { structuredKey: "hasAttachment", honorsFalse: true, toFilter: (v) => ({ kind: "hasAttachment", negated: !v, raw: "has:attachment" }) },
  { structuredKey: "hasBody", honorsFalse: true, toFilter: (v) => ({ kind: "hasBody", negated: !v, raw: "has:body" }) }
];

/**
 * The structured date-range and size fields. Dates are validated (an unparseable
 * value is dropped with a warning, never sent to `$n::timestamptz`); sizes are
 * passed through as a bound byte count. `parseQuery`'s q-operator twins
 * (`after:`/`before:`/`larger:`/`smaller:`) keep their bespoke parsing — only the
 * STRUCTURED key set is single-sourced here so the schema parity holds.
 */
export interface DateFieldRule {
  structuredKey: keyof StructuredKeySet;
  op: "after" | "before";
}
export const DATE_FIELDS: DateFieldRule[] = [
  { structuredKey: "after", op: "after" },
  { structuredKey: "before", op: "before" }
];

export interface SizeFieldRule {
  structuredKey: keyof StructuredKeySet;
  op: "larger" | "smaller";
}
export const SIZE_FIELDS: SizeFieldRule[] = [
  { structuredKey: "largerThan", op: "larger" },
  { structuredKey: "smallerThan", op: "smaller" }
];

/** The structured `window` field (the only enum-valued structured field). */
export const WINDOW_STRUCTURED_KEY = "window" as const;

/**
 * The full set of structured-object keys, derived from the table. This is the
 * single source the Zod `searchFiltersSchema` and the JSON-Schema
 * `filters.properties` are checked against (search-schema-parity.test.ts).
 *
 * `StructuredKeySet` is a compile-time companion: every `keyof StructuredFilters`
 * must appear here, and every key here must be a `keyof StructuredFilters`, so a
 * field added to the `StructuredFilters` interface without a table row (or vice
 * versa) is a type error — the table can never silently fall out of sync.
 */
interface StructuredKeySet {
  from: unknown;
  fromDomain: unknown;
  to: unknown;
  cc: unknown;
  bcc: unknown;
  anyEmail: unknown;
  subject: unknown;
  body: unknown;
  folder: unknown;
  thread: unknown;
  msgid: unknown;
  filename: unknown;
  filetype: unknown;
  mime: unknown;
  isUnread: unknown;
  isRead: unknown;
  isFlagged: unknown;
  isStarred: unknown;
  isAnswered: unknown;
  isDraft: unknown;
  hasAttachment: unknown;
  hasBody: unknown;
  after: unknown;
  before: unknown;
  largerThan: unknown;
  smallerThan: unknown;
  window: unknown;
}

/** Every structured filter field key, in the historical structured-emission order. */
export const STRUCTURED_FILTER_KEYS: (keyof StructuredKeySet)[] = [
  ...TEXT_FIELDS.filter((f): f is TextFieldRule & { structuredKey: keyof StructuredKeySet } => f.structuredKey !== undefined).map((f) => f.structuredKey),
  ...FLAG_FIELDS.map((f) => f.structuredKey),
  ...DATE_FIELDS.map((f) => f.structuredKey),
  ...SIZE_FIELDS.map((f) => f.structuredKey),
  WINDOW_STRUCTURED_KEY
];

/** Operator-alias → text field lookup, built once from {@link TEXT_FIELDS}. */
export const TEXT_FIELD_BY_OPERATOR: ReadonlyMap<string, TextFieldRule> = new Map(
  TEXT_FIELDS.flatMap((field) => field.operators.map((op) => [op, field] as const))
);
