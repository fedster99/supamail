#!/usr/bin/env node
/**
 * Email-search eval runner.
 *
 *   pnpm --filter @supamail/api eval:search              # score the current best engine
 *   pnpm --filter @supamail/api eval:search -- --compare # baseline vs improved (before → after)
 *   pnpm --filter @supamail/api eval:search -- --json    # machine-readable summary
 *
 * Exits non-zero when the graded (non-semantic) goal is not met, so it can gate CI.
 */
import { loadCases, loadCorpus, validateReferences } from "./corpus.js";
import { BASELINE_OPTIONS, IMPROVED_OPTIONS, ReferenceEngine } from "./reference-engine.js";
import { formatReport, summarize } from "./report.js";
import { runEval, type EvalReport } from "./runner.js";

function delta(a: EvalReport, b: EvalReport): string {
  const d = (x: number, y: number): string => {
    const diff = (y - x) * 100;
    const sign = diff >= 0 ? "+" : "";
    return `${sign}${diff.toFixed(1)}pp`;
  };
  return [
    "",
    `Delta (baseline → improved):`,
    `  nDCG@10         ${(a.overall.ndcg * 100).toFixed(1)}% → ${(b.overall.ndcg * 100).toFixed(1)}%  (${d(a.overall.ndcg, b.overall.ndcg)})`,
    `  recall@20       ${(a.overall.recall * 100).toFixed(1)}% → ${(b.overall.recall * 100).toFixed(1)}%  (${d(a.overall.recall, b.overall.recall)})`,
    `  MRR             ${(a.overall.mrr * 100).toFixed(1)}% → ${(b.overall.mrr * 100).toFixed(1)}%  (${d(a.overall.mrr, b.overall.mrr)})`,
    `  assertions      ${(a.overall.assertionPassRate * 100).toFixed(1)}% → ${(b.overall.assertionPassRate * 100).toFixed(1)}%  (${d(a.overall.assertionPassRate, b.overall.assertionPassRate)})`,
    `  semantic recall ${(a.semantic.recall * 100).toFixed(1)}% → ${(b.semantic.recall * 100).toFixed(1)}%  (${d(a.semantic.recall, b.semantic.recall)})`
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const compare = args.includes("--compare");
  const engineArg = args.includes("--engine")
    ? args[args.indexOf("--engine") + 1]
    : args.includes("baseline")
      ? "baseline"
      : "improved";

  const corpus = loadCorpus();
  const cases = loadCases();
  const problems = validateReferences(corpus, cases);
  if (problems.length > 0) {
    console.error("Eval corpus integrity problems:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  if (compare) {
    const base = await runEval(new ReferenceEngine(BASELINE_OPTIONS, "baseline"), corpus, cases);
    const improved = await runEval(new ReferenceEngine(IMPROVED_OPTIONS, "improved"), corpus, cases);
    if (json) {
      console.log(JSON.stringify({ baseline: summarize(base), improved: summarize(improved) }, null, 2));
    } else {
      console.log(formatReport(base));
      console.log(`\n${"=".repeat(72)}\n`);
      console.log(formatReport(improved));
      console.log(delta(base, improved));
    }
    if (!improved.goal.met) process.exitCode = 1;
    return;
  }

  const opts = engineArg === "baseline" ? BASELINE_OPTIONS : IMPROVED_OPTIONS;
  const report = await runEval(new ReferenceEngine(opts, engineArg ?? "improved"), corpus, cases);
  console.log(json ? JSON.stringify(summarize(report), null, 2) : formatReport(report));
  if (!report.goal.met) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
