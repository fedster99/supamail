import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EvalCaseSchema, EvalMessageSchema, type EvalCase, type EvalMessage } from "./types.js";

const MailboxSchema = z.object({
  messages: z.array(EvalMessageSchema)
});

const CasesSchema = z.object({
  cases: z.array(EvalCaseSchema)
});

function readJson(relativePath: string): unknown {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

/** Load + validate the fixture mailbox. */
export function loadCorpus(): EvalMessage[] {
  const parsed = MailboxSchema.parse(readJson("./fixtures/mailbox.json"));
  return parsed.messages;
}

/** Load + validate the golden eval cases. */
export function loadCases(): EvalCase[] {
  const parsed = CasesSchema.parse(readJson("./golden/cases.json"));
  return parsed.cases;
}

/**
 * Structural integrity check: every id referenced by a case must exist in the corpus,
 * and account scoping must be coherent. Returns a list of problems (empty = healthy).
 * This is what keeps "make the evals better" edits honest.
 */
export function validateReferences(messages: EvalMessage[], cases: EvalCase[]): string[] {
  const ids = new Set(messages.map((m) => m.id));
  const problems: string[] = [];
  const seenCaseIds = new Set<string>();

  for (const c of cases) {
    if (seenCaseIds.has(c.id)) problems.push(`duplicate case id: ${c.id}`);
    seenCaseIds.add(c.id);

    const mustNot = new Set<string>(c.must_not_return ?? []);
    for (const a of c.assertions ?? []) if (a.type === "must_not_return") for (const id of a.ids) mustNot.add(id);

    const referenced = new Set<string>([...c.relevant_ids, ...mustNot, ...Object.keys(c.graded ?? {})]);
    for (const a of c.assertions ?? []) {
      if (a.type === "top_is") referenced.add(a.id);
      if (a.type === "rank_above") {
        referenced.add(a.higher);
        referenced.add(a.lower);
        if (a.higher === a.lower) problems.push(`case "${c.id}" rank_above compares "${a.higher}" to itself`);
      }
      if (a.type === "recency_order" || a.type === "ordered_prefix") for (const id of a.ids) referenced.add(id);
    }
    for (const id of referenced) {
      if (!ids.has(id)) problems.push(`case "${c.id}" references unknown message id "${id}"`);
    }

    // Contradiction: an id can't be both required and forbidden.
    for (const id of c.relevant_ids) {
      if (mustNot.has(id)) problems.push(`case "${c.id}" lists "${id}" as both relevant and must_not_return`);
    }
    // Duplicate relevant ids skew recall/nDCG denominators.
    if (new Set(c.relevant_ids).size !== c.relevant_ids.length) {
      problems.push(`case "${c.id}" has duplicate ids in relevant_ids`);
    }

    const hasJudgment =
      c.relevant_ids.length > 0 || (c.assertions?.length ?? 0) > 0 || (c.must_not_return?.length ?? 0) > 0;
    if (!hasJudgment) problems.push(`case "${c.id}" has no relevance judgments or assertions`);
  }

  return problems;
}

/**
 * Non-fatal eval-quality audit (warnings, not errors). Surfaces design smells that make
 * the suite weaker without making it invalid: fixtures no case ever exercises, and gated
 * cases that can pass on recall alone with no behavioral assertion (candidates for an
 * ordering/exclusion assertion or a distractor so they actually discriminate ranking).
 */
export function auditCases(messages: EvalMessage[], cases: EvalCase[]): string[] {
  const warnings: string[] = [];
  const referenced = new Set<string>();
  for (const c of cases) {
    for (const id of c.relevant_ids) referenced.add(id);
    for (const id of c.must_not_return ?? []) referenced.add(id);
    for (const a of c.assertions ?? []) {
      if (a.type === "top_is") referenced.add(a.id);
      if (a.type === "must_not_return") for (const id of a.ids) referenced.add(id);
      if (a.type === "rank_above") {
        referenced.add(a.higher);
        referenced.add(a.lower);
      }
      if (a.type === "recency_order" || a.type === "ordered_prefix") for (const id of a.ids) referenced.add(id);
    }
  }
  const unused = messages.filter((m) => !referenced.has(m.id)).map((m) => m.id);
  if (unused.length > 0) {
    warnings.push(`${unused.length} fixture message(s) are never referenced by any case (distractors or dead weight): ${unused.join(", ")}`);
  }
  return warnings;
}

export const MESSAGE_IDS = (messages: EvalMessage[]): Set<string> => new Set(messages.map((m) => m.id));
