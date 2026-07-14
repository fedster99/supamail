import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../db.js";
import { seedCorpus } from "../eval/run.js";
import { searchMessages } from "../search/search.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

liveDb("search evaluation durable threading", () => {
  let pool: ReturnType<typeof getPool>;
  const accountIds = new Set<string>();

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    for (const accountId of accountIds) {
      await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    }
    await closePool();
  });

  it("seeds active header-only conversations and preserves dangerous provider-id splits", async () => {
    const seeded = await seedCorpus(
      pool,
      `search-eval-threading-${randomUUID()}@example.test`
    );
    accountIds.add(seeded.accountId);

    const budget = await searchMessages(pool, {
      q: "budget proposal",
      accounts: [seeded.accountId],
      limit: 20,
      recall: false
    });
    const budgetIds = budget.results
      .map((result) => result.identity.id)
      .filter((id) => ["thr-1", "thr-2", "thr-3", "thr-4"].some((synthetic) => seeded.resolve(synthetic) === id));
    expect(budgetIds).toEqual([seeded.resolve("thr-4")]);
    const budgetThread = budget.results.find((result) => result.identity.id === seeded.resolve("thr-4"))?.thread;
    expect(budgetThread).toMatchObject({
      conversation_id: expect.stringMatching(/^thread_[0-9a-f]{32}$/),
      provider_thread_id: null,
      message_count: 4
    });

    const newsletters = await searchMessages(pool, {
      q: "unsubscribe",
      accounts: [seeded.accountId],
      limit: 20,
      recall: false
    });
    const newsletterIds = new Set(newsletters.results.map((result) => result.identity.id));
    expect(newsletterIds).toEqual(new Set([
      seeded.resolve("news-1"),
      seeded.resolve("news-2"),
      seeded.resolve("news-tools")
    ]));
    const newsOne = newsletters.results.find((result) => result.identity.id === seeded.resolve("news-1"));
    const newsTwo = newsletters.results.find((result) => result.identity.id === seeded.resolve("news-2"));
    expect(newsOne?.thread.provider_thread_id).toBe("dangerously-reused-provider-id");
    expect(newsTwo?.thread.provider_thread_id).toBe("dangerously-reused-provider-id");
    expect(newsOne?.thread.conversation_id).not.toBe(newsTwo?.thread.conversation_id);
  });
});
