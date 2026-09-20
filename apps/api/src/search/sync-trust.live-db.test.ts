import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../db.js";
import { buildSyncTrust } from "./sync-trust.js";

const liveDb = process.env.LIVE_DB_TESTS === "1" && process.env.DATABASE_URL
  ? describe : describe.skip;

liveDb("scoped sync trust against the public progress view", () => {
  const accountIds = [randomUUID(), randomUUID(), randomUUID()];
  let pool: ReturnType<typeof getPool>;

  beforeAll(async () => {
    pool = getPool();
    for (const [index, id] of accountIds.entries()) {
      await pool.query(`
        INSERT INTO public.imap_accounts
          (id, email_address, host, port, username, encrypted_password, sync_state)
        VALUES ($1, $2, 'imap.example.test', 993, $2, $3, 'HEALTHY')
      `, [id, `sync-trust-${id}@example.test`, Buffer.from([0])]);
      await pool.query(`
        INSERT INTO public.imap_folders
          (account_id, path, tracked, sync_priority, live_window_target_count,
           headers_synced_count, historical_target_count, bodies_fetched_count)
        VALUES ($1, 'INBOX', true, 0, $2, $2, 3, $2 + 2)
      `, [id, index === 1 ? 0 : 2]);
      if (index === 1) continue; // A known-empty mailbox is complete, not unknown.
      for (const uid of [1, 2]) {
        const message = await pool.query<{ id: string }>(`
          INSERT INTO public.imap_messages
            (account_id, folder_path, uidvalidity, uid, internal_date,
             window_status, body_fetched_at)
          VALUES ($1, 'INBOX', 1, $2, now(), 'IN_WINDOW', now()) RETURNING id
        `, [id, uid]);
        await pool.query(`
          INSERT INTO public.imap_message_bodies (message_id, raw_truncated, raw_bytes)
          VALUES ($1, $2, 0)
        `, [message.rows[0].id, index === 0 && uid === 2]);
      }
    }
  });

  afterAll(async () => {
    if (pool) await pool.query("DELETE FROM public.imap_accounts WHERE id = ANY($1::uuid[])", [accountIds]);
    await closePool();
  });

  it("preserves row-accurate completeness and selects each requested mailbox once", async () => {
    const trust = await buildSyncTrust(pool, [accountIds[1], accountIds[0], accountIds[0]]);
    expect(trust.accounts.map(a => a.account_id)).toEqual(accountIds.slice(0, 2).sort());
    expect(trust.accounts.find(a => a.account_id === accountIds[0])).toMatchObject({
      live_headers_complete_pct: 100, live_bodies_complete_pct: 50,
      historical_bodies_complete_pct: 67
    });
    expect(trust.accounts.find(a => a.account_id === accountIds[1])).toMatchObject({
      live_headers_complete_pct: 100, live_bodies_complete_pct: 100
    });
    expect(trust.fully_synced).toBe(false);
    expect(trust.degraded_reasons).toContain("bodies_incomplete");
    const single = await buildSyncTrust(pool, [accountIds[0]]);
    expect(single.accounts).toEqual([trust.accounts.find(a => a.account_id === accountIds[0])]);
    const empty = await buildSyncTrust(pool, [accountIds[1]]);
    expect(empty.fully_synced).toBe(true);
  });

  it("retains explicit empty, missing and unfiltered scope semantics", async () => {
    for (const scope of [[], [randomUUID()]]) {
      const trust = await buildSyncTrust(pool, scope);
      expect(trust.accounts).toEqual([]);
      expect(trust.degraded_reasons).toEqual(["no_accounts_matched"]);
    }
    const all = await buildSyncTrust(pool, null);
    for (const id of accountIds) expect(all.accounts.filter(a => a.account_id === id)).toHaveLength(1);
  });
});
