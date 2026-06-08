import { DEFAULT_K, DEFAULT_RECALL_K, GOAL } from "./config.js";
import type { AggregateMetrics, CaseResult, EvalReport } from "./runner.js";

function pct(n: number): string {
  return (n * 100).toFixed(1).padStart(5);
}

function aggLine(label: string, m: AggregateMetrics): string {
  return (
    `  ${label.padEnd(14)} ` +
    `nDCG@${DEFAULT_K} ${pct(m.ndcg)}%  ` +
    `recall@${DEFAULT_RECALL_K} ${pct(m.recall)}%  ` +
    `MRR ${pct(m.mrr)}%  ` +
    `assert ${pct(m.assertionPassRate)}%  ` +
    `(n=${m.count})`
  );
}

/** A human-readable scorecard for the CLI runner. */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`Email-search eval — engine: ${report.engine}`);
  lines.push("");
  lines.push(aggLine("OVERALL", report.overall));
  if (report.semantic.count > 0) lines.push(aggLine("semantic*", report.semantic));
  lines.push("");
  lines.push("By capability:");
  const caps = Object.keys(report.byCapability).sort();
  for (const cap of caps) {
    const m = report.byCapability[cap as keyof typeof report.byCapability];
    if (m) lines.push(aggLine(cap, m));
  }

  const failing = report.cases.filter((c) => isWeak(c));
  if (failing.length > 0) {
    lines.push("");
    lines.push("Weak cases:");
    for (const c of failing) {
      const failedAssertions = c.assertions.filter((a) => !a.passed);
      const detail = failedAssertions.map((a) => `${a.type}: ${a.detail ?? "failed"}`).join("; ");
      lines.push(
        `  [${c.tier === "semantic" ? "sem" : "   "}] ${c.id.padEnd(28)} ` +
          `nDCG ${pct(c.ndcg)}% recall ${pct(c.recall)}% MRR ${pct(c.mrr)}%` +
          (detail ? `  ✗ ${detail}` : "")
      );
    }
  }

  lines.push("");
  lines.push(
    `GOAL (non-semantic): nDCG@${DEFAULT_K}≥${GOAL.ndcg} recall@${DEFAULT_RECALL_K}≥${GOAL.recall} ` +
      `MRR≥${GOAL.mrr} assertions=${GOAL.assertionPassRate}`
  );
  if (report.goal.met) {
    lines.push("RESULT: ✅ goal met");
  } else {
    lines.push("RESULT: ❌ goal NOT met");
    for (const f of report.goal.failures) lines.push(`  - ${f}`);
  }
  lines.push("* semantic tier is tracked, not gated (production Tier-2 vector arm satisfies it).");
  return lines.join("\n");
}

function isWeak(c: CaseResult): boolean {
  if (c.assertions.some((a) => !a.passed)) return true;
  if (c.tier === "semantic") return c.recall < GOAL.semanticRecallTarget;
  return c.ndcg < GOAL.ndcg || c.recall < GOAL.recall || c.mrr < GOAL.mrr;
}

/** Compact machine-readable summary for baseline snapshots / regression gating. */
export function summarize(report: EvalReport): Record<string, unknown> {
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  return {
    engine: report.engine,
    overall: {
      count: report.overall.count,
      ndcg: round(report.overall.ndcg),
      recall: round(report.overall.recall),
      mrr: round(report.overall.mrr),
      assertionPassRate: round(report.overall.assertionPassRate)
    },
    semantic: {
      count: report.semantic.count,
      recall: round(report.semantic.recall)
    },
    goalMet: report.goal.met
  };
}
