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
  groupByThread: true
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
});

describe("compileSearch", () => {
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
