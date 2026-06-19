import { describe, expect, it } from "vitest";
import { compileSearch } from "../search/index.js";
import type { CompileOptions } from "../search/compile.js";
import { expandConcepts, significantTerms } from "../search/expand.js";

describe("significantTerms", () => {
  it("keeps content words, drops stopwords and short tokens, dedupes", () => {
    expect(significantTerms("show me the invoice from acme")).toEqual(["invoice", "acme"]);
  });

  it("folds diacritics and lowercases", () => {
    expect(significantTerms("Café RÉSUMÉ")).toEqual(["cafe", "resume"]);
  });

  it("preserves a misspelled token verbatim (fuzzy matches it later)", () => {
    expect(significantTerms("invioce")).toEqual(["invioce"]);
  });

  it("is empty for whitespace", () => {
    expect(significantTerms("   ")).toEqual([]);
  });

  it("caps the fan-out", () => {
    const many = significantTerms("alpha bravo charlie delta echo foxtrot golf hotel india");
    expect(many.length).toBeLessThanOrEqual(8);
  });
});

describe("expandConcepts", () => {
  it("expands an intent word to its concept group, excluding the term itself", () => {
    const syns = expandConcepts(["vacation"]);
    expect(syns).toContain("flight");
    expect(syns).toContain("hotel");
    expect(syns).not.toContain("vacation");
  });

  it("maps the four eval intents to their domains", () => {
    expect(expandConcepts(["hiring"])).toContain("candidate");
    expect(expandConcepts(["breach"])).toContain("login");
    expect(expandConcepts(["expense"])).toContain("invoice");
  });

  it("returns nothing for a term that is not a known concept", () => {
    expect(expandConcepts(["zzqxnotaword"])).toEqual([]);
  });

  it("unions groups when several terms are concepts", () => {
    const syns = expandConcepts(["flight", "invoice"]);
    expect(syns).toContain("hotel");
    expect(syns).toContain("payment");
  });
});

const baseOptions: CompileOptions = {
  accountIds: null,
  windowStatus: null,
  includeDeleted: false,
  sort: "smart",
  hasText: true,
  limit: 25,
  offset: 0,
  snippet: false,
  includeBody: false,
  groupByThread: true,
  terms: [],
  synonyms: []
};

describe("compileSearch recall branches", () => {
  it("emits the fuzzy trigram branch and is_primary tiering when terms are present", () => {
    const compiled = compileSearch("invioce", [], { ...baseOptions, terms: ["invioce"] });
    expect(compiled.text).toContain("OPERATOR(extensions.<%)");
    expect(compiled.text).toContain("word_similarity");
    expect(compiled.text).toContain("is_primary");
    expect(compiled.values).toContain("invioce");
  });

  it("emits the concept-widened tsquery when synonyms are present", () => {
    const compiled = compileSearch("vacation", [], {
      ...baseOptions,
      terms: ["vacation"],
      synonyms: ["flight", "hotel"]
    });
    // primary tsquery OR-ed with each synonym
    expect(compiled.text).toMatch(/\|\| websearch_to_tsquery/);
    expect(compiled.values).toContain("flight");
    expect(compiled.values).toContain("hotel");
  });

  it("stays on the plain lexical path (no recall branches) when terms/synonyms are empty", () => {
    const compiled = compileSearch("invoice", [], baseOptions);
    expect(compiled.text).not.toContain("OPERATOR(extensions.<%)");
    // is_primary is always projected so the order clause is stable.
    expect(compiled.text).toContain("is_primary");
  });
});
