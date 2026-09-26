import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../db.js";
import { buildSyncTrust } from "./sync-trust.js";

const liveDb = process.env.LIVE_DB_TESTS === "1" && process.env.DATABASE_URL ? describe : describe.skip;

liveDb("sync trust singleton scope live DB", () => {
  const ids: string[] = [randomUUID(), randomUUID()];
  let messageId = "";
  let pool: ReturnType<typeof getPool>;

  beforeAll(async () => {
    pool = getPool();
    for (const id of ids) {
      await pool.query(`INSERT INTO public.imap_accounts
        (id,email_address,host,port,username,encrypted_password,sync_state)
        VALUES ($1,$2,'imap.example.test',993,$2,$3,'HEALTHY')`,
      [id, `${id}@example.test`, Buffer.from([0])]);
      await pool.query(`INSERT INTO public.imap_folders
        (account_id,path,tracked,status,sync_priority,live_window_target_count,headers_synced_count)
        VALUES ($1,'INBOX',true,'ACTIVE',1,1,1)`, [id]);
    }
    const row = await pool.query<{ id: string }>(`INSERT INTO public.imap_messages
      (account_id,folder_path,uidvalidity,uid,internal_date,window_status,deleted_in_provider)
      VALUES ($1,'INBOX',1,1,now(),'IN_WINDOW',false) RETURNING id`, [ids[0]]);
    messageId = row.rows[0].id;
    await pool.query(`INSERT INTO public.imap_message_bodies
      (message_id,raw_bytes,raw_truncated,body_text) VALUES ($1,4,false,'body')`, [messageId]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM public.imap_accounts WHERE id=ANY($1::uuid[])", [ids]);
    await closePool();
  });

  it("matches multi-account results without turning pre-store evidence into completion", async () => {
    const one = await buildSyncTrust(pool, [ids[0]]);
    const both = await buildSyncTrust(pool, ids);
    expect(one.accounts).toEqual(both.accounts.filter(a => a.account_id === ids[0]));
    expect(one.accounts[0].live_bodies_complete_pct).toBe(0);
    expect(one.fully_synced).toBe(false);

    await pool.query("UPDATE public.imap_messages SET body_fetched_at=now() WHERE id=$1", [messageId]);
    const completed = await buildSyncTrust(pool, [ids[0]]);
    expect(completed.accounts[0].live_bodies_complete_pct).toBe(100);
    expect(completed.fully_synced).toBe(true);

    await pool.query("UPDATE public.imap_message_bodies SET raw_truncated=true WHERE message_id=$1", [messageId]);
    expect((await buildSyncTrust(pool, [ids[0]])).accounts[0].live_bodies_complete_pct).toBe(0);
  });

  it("preserves empty, unmatched, duplicate, and unrestricted scopes", async () => {
    expect((await buildSyncTrust(pool, [])).accounts).toEqual([]);
    expect((await buildSyncTrust(pool, [randomUUID()])).accounts).toEqual([]);
    const one = await buildSyncTrust(pool, [ids[0]]);
    expect((await buildSyncTrust(pool, [ids[0], ids[0]])).accounts).toEqual(one.accounts);
    const all = await buildSyncTrust(pool, null);
    const both = await buildSyncTrust(pool, ids);
    expect(all.accounts.filter(a => ids.includes(a.account_id))).toEqual(both.accounts);
  });
});
