import { describe, expect, it } from "vitest";
import { compileSearch, filtersFromStructured, parseQuery, tokenize } from "../search/index.js";
import type { CompileOptions } from "../search/compile.js";
import type { SearchFilter } from "../search/types.js";

function findFilter<K extends SearchFilter["kind"]>(
  filters: SearchFilter[],
  kind: K
): Extract<SearchFilter, { kind: K }> | undefined {
  return filters.find((f) => f.kind === kind) as Extract<SearchFilter, { kind: K }> | undefined;
}

const baseCompileOptions: CompileOptions = {
  accountIds: null,
  windowStatus: null,
  includeDeleted: false,
  sort: "smart",
  hasText: false,
  limit: 25,
  offset: 0,
  snippet: true,
  includeBody: false,
  groupByThread: true,
  terms: [],
  synonyms: [],
  now: null
};

describe("tokenize", () => {
  it("keeps quoted spans atomic, including operator values", () => {
    expect(tokenize('from:bob subject:"weekly report" "exact phrase" -in:Spam')).toEqual([
      "from:bob",
      'subject:"weekly report"',
      '"exact phrase"',
      "-in:Spam"
    ]);
  });
});

describe("parseQuery", () => {
  it("treats bare words as free text and lowercases sender operators", () => {
    const parsed = parseQuery("invoice from:Bob@Acme.com");
    expect(parsed.freeText).toBe("invoice");
    expect(findFilter(parsed.filters, "from")?.value).toBe("bob@acme.com");
  });

  it("routes from:@domain to a domain filter", () => {
    const parsed = parseQuery("from:@acme.com");
    expect(findFilter(parsed.filters, "fromDomain")?.value).toBe("acme.com");
  });

  it("maps is:unread to a negated Seen flag and -from to a negated sender", () => {
    const unread = findFilter(parseQuery("is:unread").filters, "flag");
    expect(unread).toMatchObject({ value: "\\Seen", negated: true });
    expect(findFilter(parseQuery("-from:spam").filters, "from")?.negated).toBe(true);
  });

  it("keeps quoted operator values and leaves the rest as free text", () => {
    const parsed = parseQuery('subject:"weekly report" hello world');
    expect(findFilter(parsed.filters, "subject")?.value).toBe("weekly report");
    expect(parsed.freeText).toBe("hello world");
  });

  it("parses relative dates and human sizes", () => {
    const parsed = parseQuery("after:7d larger:2mb");
    expect(findFilter(parsed.filters, "date")).toMatchObject({ op: "after", value: "7d" });
    expect(findFilter(parsed.filters, "size")).toMatchObject({ op: "larger", value: 2 * 1024 * 1024 });
  });

  it("collects account operators and output controls", () => {
    const parsed = parseQuery("hello account:work@x.com sort:recent limit:5");
    expect(parsed.accounts).toEqual(["work@x.com"]);
    expect(parsed.sort).toBe("recent");
    expect(parsed.limit).toBe(5);
    expect(parsed.freeText).toBe("hello");
  });

  it("demotes unknown operators and URLs to free text instead of throwing", () => {
    const parsed = parseQuery("read http://example.com/x foo:bar");
    expect(parsed.filters).toHaveLength(0);
    expect(parsed.freeText).toContain("http://example.com/x");
    expect(parsed.freeText).toContain("foo:bar");
  });

  it("warns on an unknown is: value rather than filtering", () => {
    const parsed = parseQuery("is:purple");
    expect(parsed.filters).toHaveLength(0);
    expect(parsed.warnings.join(" ")).toContain("is:purple");
  });
});

describe("filtersFromStructured", () => {
  it("maps a structured object onto the same filter union as the string parser", () => {
    const filters = filtersFromStructured({ from: "bob@acme.com", isUnread: true, hasAttachment: true });
    expect(findFilter(filters, "from")?.value).toBe("bob@acme.com");
    expect(findFilter(filters, "flag")).toMatchObject({ value: "\\Seen", negated: true });
    expect(findFilter(filters, "hasAttachment")?.negated).toBe(false);
  });

  it("an empty structured object yields no filters (absent filters = no-op)", () => {
    expect(filtersFromStructured({})).toEqual([]);
  });
});

// email-005: structured field/state/date/folder filter parity over the mirror.
describe("email-005 structured filters", () => {
  it("routes to/cc/bcc/anyEmail to their own scoped filter kinds (lowercased)", () => {
    const parsed = parseQuery("to:To@X.com cc:Cc@X.com bcc:Bcc@X.com anyemail:Any@X.com");
    expect(findFilter(parsed.filters, "to")?.value).toBe("to@x.com");
    expect(findFilter(parsed.filters, "cc")?.value).toBe("cc@x.com");
    expect(findFilter(parsed.filters, "bcc")?.value).toBe("bcc@x.com");
    expect(findFilter(parsed.filters, "anyEmail")?.value).toBe("any@x.com");
  });

  it("keeps recipient:/participant:/with: as the broad (to+cc) filter", () => {
    expect(findFilter(parseQuery("recipient:x@y.com").filters, "recipient")?.value).toBe("x@y.com");
    expect(findFilter(parseQuery("with:x@y.com").filters, "recipient")?.value).toBe("x@y.com");
  });

  it("maps the structured to/cc/bcc/anyEmail object fields to the scoped kinds", () => {
    const filters = filtersFromStructured({ to: "a@x.com", cc: "b@x.com", bcc: "c@x.com", anyEmail: "d@x.com" });
    expect(findFilter(filters, "to")?.value).toBe("a@x.com");
    expect(findFilter(filters, "cc")?.value).toBe("b@x.com");
    expect(findFilter(filters, "bcc")?.value).toBe("c@x.com");
    expect(findFilter(filters, "anyEmail")?.value).toBe("d@x.com");
  });

  it("treats isStarred as the Flagged flag (Nylas/Gmail star)", () => {
    const filters = filtersFromStructured({ isStarred: true });
    expect(findFilter(filters, "flag")).toMatchObject({ value: "\\Flagged", negated: false });
    expect(findFilter(parseQuery("is:starred").filters, "flag")).toMatchObject({ value: "\\Flagged", negated: false });
  });

  it("composes a semantic free-text query with the structured filters (narrows, never replaces)", () => {
    const parsed = parseQuery("invoice unread from:acme to:me@x.com");
    // Free text survives for websearch_to_tsquery; the operators become filters.
    expect(parsed.freeText).toContain("invoice");
    expect(parsed.freeText).toContain("unread");
    expect(findFilter(parsed.filters, "from")?.value).toBe("acme");
    expect(findFilter(parsed.filters, "to")?.value).toBe("me@x.com");
  });

  it("compiles to/cc/bcc against their own array column and anyEmail across all of them", () => {
    const toC = compileSearch("", filtersFromStructured({ to: "a@x.com" }), baseCompileOptions);
    expect(toC.text).toContain("m.to_emails");
    expect(toC.text).not.toContain("m.cc_emails");
    expect(toC.values).toContain("%a@x.com%");

    const ccC = compileSearch("", filtersFromStructured({ cc: "b@x.com" }), baseCompileOptions);
    expect(ccC.text).toContain("m.cc_emails");

    const bccC = compileSearch("", filtersFromStructured({ bcc: "c@x.com" }), baseCompileOptions);
    expect(bccC.text).toContain("m.bcc_emails");

    const anyC = compileSearch("", filtersFromStructured({ anyEmail: "d@x.com" }), baseCompileOptions);
    expect(anyC.text).toContain("m.from_email");
    expect(anyC.text).toContain("m.to_emails");
    expect(anyC.text).toContain("m.cc_emails");
    expect(anyC.text).toContain("m.bcc_emails");
  });

  it("binds an injection-shaped recipient value as a parameter, never inlining it", () => {
    const evil = `x%_'; drop table imap_messages;--`;
    const compiled = compileSearch("", filtersFromStructured({ cc: evil, anyEmail: evil }), baseCompileOptions);
    // The dangerous text never appears in the SQL string...
    expect(compiled.text).not.toContain("drop table");
    expect(compiled.text).not.toContain(evil);
    // ...and the % / _ LIKE metacharacters in the value are escaped, then bound.
    expect(compiled.values.some((v) => typeof v === "string" && v.includes("\\%") && v.includes("\\_"))).toBe(true);
  });

  it("ignores an invalid structured date (warn, no filter) but keeps relative + absolute ones", () => {
    // An unparseable `after` must NOT reach the compiler (where `$n::timestamptz`
    // would make Postgres 500); it is dropped with a warning, exactly like after:.
    const warnings: string[] = [];
    const filters = filtersFromStructured({ after: "garbage" }, warnings);
    expect(findFilter(filters, "date")).toBeUndefined();
    expect(warnings.join(" ")).toContain("unparseable date");

    // A relative spec (7d) and an absolute date still parse to a date filter.
    expect(findFilter(filtersFromStructured({ after: "7d" }), "date")).toMatchObject({ op: "after", value: "7d" });
    expect(findFilter(filtersFromStructured({ before: "2026-01-01" }), "date")).toMatchObject({ op: "before", value: "2026-01-01" });
  });

  it("honors unread=false (read) and starred=false (not starred) instead of silently dropping them", () => {
    // false is not a no-op: it inverts, the way hasAttachment:false means "no attachment".
    expect(findFilter(filtersFromStructured({ isUnread: false }), "flag")).toMatchObject({ value: "\\Seen", negated: false });
    expect(findFilter(filtersFromStructured({ isUnread: true }), "flag")).toMatchObject({ value: "\\Seen", negated: true });
    expect(findFilter(filtersFromStructured({ isStarred: false }), "flag")).toMatchObject({ value: "\\Flagged", negated: true });
    expect(findFilter(filtersFromStructured({ isStarred: true }), "flag")).toMatchObject({ value: "\\Flagged", negated: false });
  });

  it("narrows by received_after/received_before (date range) and folder scope, paginated", () => {
    const compiled = compileSearch(
      "",
      filtersFromStructured({ after: "2026-01-01", before: "2026-02-01", folder: "INBOX" }),
      { ...baseCompileOptions, limit: 10, offset: 20 }
    );
    expect(compiled.text).toContain("m.internal_date >=");
    expect(compiled.text).toContain("m.internal_date <");
    expect(compiled.text).toContain("lower(m.folder_path) =");
    // Pagination: LIMIT n+1 (has_more probe) and the bound offset are present.
    expect(compiled.values).toContain(11);
    expect(compiled.values).toContain(20);
    expect(compiled.values).toContain("inbox");
  });
});

describe("compileSearch", () => {
  it("deduplicates deliveries before account-scoped conversation grouping", () => {
    const compiled = compileSearch("", [], baseCompileOptions);

    expect(compiled.text).toContain("LEFT JOIN public.imap_thread_active_assignments ta");
    expect(compiled.text).toContain("ta.delivery_key");
    expect(compiled.text).toContain("b.raw_mime_sha256");
    expect(compiled.text).toContain("ELSE 'physical:' || m.id::text");
    expect(compiled.text).toContain("THEN 'conversation:' || ta.conversation_id");
    expect(compiled.text).toContain("THEN 'provider-thread:' || encode(extensions.digest(");
    expect(compiled.text).toContain("coalesce(m.provider_thread_id_namespace, 'legacy')");
    expect(compiled.text).toContain("SELECT DISTINCT ON (r.account_id, r.delivery_key) r.*");
    expect(compiled.text).toContain(
      "count(*) OVER (PARTITION BY d.account_id, d.conversation_key)::int AS thread_count"
    );
    expect(compiled.text).toContain("SELECT DISTINCT ON (c.account_id, c.conversation_key) c.*");
    expect(compiled.text).toContain("page.window_status, page.internal_date, page.conversation_id");
  });

  it("resolves a thread: selector only through the active assignment view and keeps the value bound", () => {
    const selector = `thread_' ; drop table imap_messages;--`;
    const compiled = compileSearch("", filtersFromStructured({ thread: selector }), baseCompileOptions);

    expect(compiled.text).toContain("FROM public.imap_thread_active_assignments thread_assignment");
    expect(compiled.text).not.toContain("FROM public.imap_thread_assignments thread_assignment");
    expect(compiled.text).not.toContain(selector);
    expect(compiled.values).toContain(selector);
  });

  it("binds every user value as a parameter and never interpolates it into SQL text", () => {
    const compiled = compileSearch("invoice", filtersFromStructured({ from: "acme" }), {
      ...baseCompileOptions,
      hasText: true
    });
    // The user's free text and operator value live in the values array...
    expect(compiled.values).toContain("invoice");
    expect(compiled.values).toContain("%acme%");
    // ...and NOT inlined into the SQL string (injection safety).
    expect(compiled.text).not.toContain("invoice");
    expect(compiled.text).not.toContain("acme");
    expect(compiled.text).toContain("websearch_to_tsquery('english', public.f_unaccent(");
  });

  it("emits the soft-delete partial-index predicate by default", () => {
    const compiled = compileSearch("", [], baseCompileOptions);
    expect(compiled.text).toContain("m.deleted_in_provider = false");
  });

  it("drops the soft-delete predicate only when includeDeleted is set", () => {
    const compiled = compileSearch("", [], { ...baseCompileOptions, includeDeleted: true });
    expect(compiled.text).not.toContain("m.deleted_in_provider = false");
  });

  it("scopes by account when account ids are provided", () => {
    const compiled = compileSearch("", [], {
      ...baseCompileOptions,
      accountIds: ["11111111-1111-1111-1111-111111111111"]
    });
    expect(compiled.text).toContain("m.account_id = ANY(");
    expect(compiled.values).toContainEqual(["11111111-1111-1111-1111-111111111111"]);
  });

  it("resolves a relative date to a now()-relative interval, not a bound timestamp", () => {
    const parsed = parseQuery("after:7d");
    const compiled = compileSearch("", parsed.filters, baseCompileOptions);
    expect(compiled.text).toContain("now() - (");
    expect(compiled.text).toContain("interval '1 day'");
    expect(compiled.values).toContain(7);
  });
});
