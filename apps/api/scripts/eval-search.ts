import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const dockerImage = process.env.LIVE_DB_POSTGRES_IMAGE ?? "postgres:16-alpine";

type Scorecard = import("../src/eval/run.js").Scorecard;
type QueryMetrics = import("../src/eval/metrics.js").QueryMetrics;

async function docker(args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, { maxBuffer: 10 * 1024 * 1024 });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    if (allowFailure) return "";
    throw new Error(`docker ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function startDisposablePostgres(): Promise<{ url: string; cleanup: () => Promise<void> }> {
  const name = `supamail-eval-${process.pid}-${randomUUID().slice(0, 8)}`;
  await docker([
    "run", "-d", "--rm", "--name", name,
    "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_DB=postgres",
    "-p", "127.0.0.1::5432", dockerImage
  ]);
  const cleanup = async (): Promise<void> => {
    await docker(["rm", "-f", name], true);
  };
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = await docker(["exec", name, "pg_isready", "-U", "postgres", "-d", "postgres"], true);
      if (ready.includes("accepting connections")) break;
      await delay(500);
    }
    const portOutput = await docker(["port", name, "5432/tcp"]);
    const match = portOutput.match(/:(\d+)\s*$/m) ?? portOutput.match(/:(\d+)/);
    if (!match) throw new Error(`Could not parse mapped Postgres port from: ${portOutput}`);
    return { url: `postgresql://postgres:postgres@127.0.0.1:${match[1]}/postgres`, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function pct(value: number): string {
  return (value * 100).toFixed(1).padStart(5) + "%";
}

function metricRow(label: string, metrics: QueryMetrics): string {
  return [
    label.padEnd(12),
    `nDCG@10 ${pct(metrics.ndcg_at_10)}`,
    `R@10 ${pct(metrics.recall_at_10)}`,
    `MRR ${metrics.reciprocal_rank.toFixed(3)}`,
    `P@5 ${pct(metrics.precision_at_5)}`,
    `success@10 ${pct(metrics.success_at_10)}`
  ].join("  ");
}

function printScorecard(scorecard: Scorecard): void {
  const line = "─".repeat(86);
  console.error(line);
  console.error(`SupaMail search evaluation — ${scorecard.corpus_size} messages, ${scorecard.query_count} judged queries`);
  console.error(line);
  console.error(
    `HEADLINE  nDCG@10 ${pct(scorecard.headline.ndcg_at_10)}   ` +
    `Recall@10 ${pct(scorecard.headline.recall_at_10)}   MRR ${scorecard.headline.mrr.toFixed(3)}`
  );
  console.error(line);
  console.error("BY CATEGORY");
  for (const category of scorecard.by_category) {
    console.error(
      "  " + metricRow(`${category.category} (${category.query_count})`, category.metrics) +
      `  threads ${pct(category.distinct_thread_ratio)}`
    );
  }
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

async function main(): Promise<void> {
  let cleanup: (() => Promise<void>) | null = null;

  if (!process.env.DATABASE_URL) {
    console.error(`[eval:search] no DATABASE_URL set; starting disposable ${dockerImage}`);
    const disposable = await startDisposablePostgres();
    process.env.DATABASE_URL = disposable.url;
    cleanup = disposable.cleanup;
  }
  process.env.IMAP_ENCRYPTION_KEY ??= "local-eval-encryption-key";
  process.env.IMAP_ALLOW_PRIVATE_HOSTS ??= "true";

  try {
    const { getPool, applyPublicMigrations, closePool } = await import("../src/db.js");
    const { evaluateSearch } = await import("../src/eval/run.js");

    const pool = getPool();
    await applyPublicMigrations(pool);
    const scorecard = await evaluateSearch(pool);
    await closePool();

    printScorecard(scorecard);
    // Machine-readable scorecard to stdout (summary went to stderr).
    process.stdout.write(`${JSON.stringify(scorecard, null, 2)}\n`);
  } finally {
    if (cleanup) await cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
