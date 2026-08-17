import {
  EphemeralPostgres,
  installEphemeralPostgresSignalHandlers
} from "./ephemeral-postgres.js";

const dockerImage = process.env.LIVE_DB_POSTGRES_IMAGE ?? "postgres:16-alpine";

type Scorecard = import("../src/eval/run.js").Scorecard;
type ComparisonReport = import("../src/eval/run.js").ComparisonReport;
type QueryMetrics = import("../src/eval/metrics.js").QueryMetrics;

function pct(value: number): string {
  return (value * 100).toFixed(1).padStart(5) + "%";
}

function ratioPct(value: number | null): string {
  return value === null ? "   —  " : pct(value);
}

function metricRow(label: string, metrics: QueryMetrics): string {
  return [
    label.padEnd(12),
    `nDCG@10 ${pct(metrics.ndcg_at_10)}`,
    `@3 ${pct(metrics.ndcg_at_3)}`,
    `R@10 ${pct(metrics.recall_at_10)}`,
    `MRR ${metrics.reciprocal_rank.toFixed(3)}`,
    `s@1 ${pct(metrics.success_at_1)}`
  ].join("  ");
}

function printScorecard(scorecard: Scorecard): void {
  const line = "─".repeat(86);
  console.error(line);
  console.error(`SupaMail search evaluation — ${scorecard.corpus_size} messages, ${scorecard.query_count} judged queries`);
  console.error(line);
  console.error(
    `HEADLINE  nDCG@10 ${pct(scorecard.headline.ndcg_at_10)}   ` +
    `Recall@10 ${pct(scorecard.headline.recall_at_10)}   MRR ${scorecard.headline.mrr.toFixed(3)}` +
    `   (clock frozen @ ${scorecard.eval_now})`
  );
  console.error(line);
  console.error("BY CATEGORY  (sat = share nDCG@10 ≥ 0.95)");
  for (const category of scorecard.by_category) {
    console.error(
      "  " + metricRow(`${category.category} (${category.query_count})`, category.metrics) +
      `  sat ${pct(category.saturated_share)}  threads ${ratioPct(category.distinct_thread_ratio)}`
    );
  }
  console.error(line);
  const g = scorecard.guard;
  console.error(
    `GUARD (junk-return sentinels)  ${g.passed}/${g.total} pass` +
    (g.failures.length > 0
      ? "\n" + g.failures.map((f) => `  FAIL ${f.id} "${f.q}" returned ${f.returned}`).join("\n")
      : "")
  );
  console.error(line);
  console.error("WEAK QUERIES (recall@10 < 100%)");
  const weak = scorecard.queries.filter((q) => q.metrics.recall_at_10 < 1);
  if (weak.length === 0) {
    console.error("  (none)");
  } else {
    for (const q of weak) {
      console.error(
        `  [${q.category}] ${q.id} "${q.q}" → R@10 ${pct(q.metrics.recall_at_10)} ` +
        `nDCG@10 ${pct(q.metrics.ndcg_at_10)} missing: ${q.missing.join(", ") || "—"}`
      );
    }
  }
  const topFirstFails = scorecard.queries.filter((q) => q.top_first_ok === false);
  if (topFirstFails.length > 0) {
    console.error(line);
    console.error("RANKING MISSES (expected result not ranked first)");
    for (const q of topFirstFails) console.error(`  ${q.id} "${q.q}"`);
  }
  console.error(line);
}

function sig(p: number): string {
  return p < 0.001 ? "p<0.001" : `p=${p.toFixed(3)}`;
}

function printComparison(report: ComparisonReport): void {
  const line = "─".repeat(86);
  console.error(line);
  console.error(`SupaMail search A/B — ${report.candidate_label}  vs  ${report.baseline_label}`);
  console.error(`metric: ${report.metric} (paired permutation test + bootstrap 95% CI, fixed seed)`);
  console.error(line);
  const row = (label: string, c: ComparisonReport["overall"]): string => {
    const flag = c.significant_improvement ? "▲ sig" : c.significant_regression ? "▼ REGRESS" : "· ns";
    return [
      label.padEnd(20),
      `base ${pct(c.mean_baseline)}`,
      `cand ${pct(c.mean_candidate)}`,
      `Δ ${(c.mean_delta >= 0 ? "+" : "") + (c.mean_delta * 100).toFixed(1)}pt`,
      `CI[${(c.ci_lower * 100).toFixed(1)}, ${(c.ci_upper * 100).toFixed(1)}]`,
      sig(c.p_value).padEnd(8),
      flag
    ].join("  ");
  };
  console.error(row(`OVERALL (n=${report.overall.n})`, report.overall));
  console.error(line);
  for (const c of report.by_category) {
    const directional = c.comparison.n < 5 ? "  (directional, n<5)" : "";
    console.error(row(`${c.category} (n=${c.comparison.n})`, c.comparison) + directional);
  }
  console.error(line);
  console.error(
    report.significant_regressions.length === 0
      ? "GATE: no category significantly worse than baseline ✓"
      : `GATE: SIGNIFICANT REGRESSION in ${report.significant_regressions.join(", ")} ✗`
  );
  console.error(line);
}

async function main(): Promise<void> {
  const compareMode = process.argv.includes("--compare") || process.argv.includes("--baseline");
  let disposable: EphemeralPostgres | null = null;
  let removeSignalHandlers: (() => void) | null = null;

  if (!process.env.DATABASE_URL) {
    console.error(`[eval:search] no DATABASE_URL set; starting disposable ${dockerImage}`);
    disposable = new EphemeralPostgres({
      image: dockerImage,
      namePrefix: "supamail-eval",
      purpose: "search-evaluation"
    });
    removeSignalHandlers = installEphemeralPostgresSignalHandlers(disposable, {
      logPrefix: "[eval:search]"
    });
    process.env.DATABASE_URL = await disposable.start();
  }
  process.env.IMAP_ENCRYPTION_KEY ??= "local-eval-encryption-key";
  process.env.IMAP_ALLOW_PRIVATE_HOSTS ??= "true";

  try {
    const { getPool, applyPublicMigrations, closePool } = await import("../src/db.js");
    const { evaluateSearch, compareSearch } = await import("../src/eval/run.js");

    const pool = getPool();
    await applyPublicMigrations(pool);

    if (compareMode) {
      const report = await compareSearch(pool);
      await closePool();
      printComparison(report);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    const scorecard = await evaluateSearch(pool);
    await closePool();
    printScorecard(scorecard);
    // Machine-readable scorecard to stdout (summary went to stderr).
    process.stdout.write(`${JSON.stringify(scorecard, null, 2)}\n`);
  } finally {
    try {
      if (disposable) await disposable.cleanup("completion");
    } finally {
      removeSignalHandlers?.();
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
