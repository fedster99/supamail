import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../../db.js";
import { runReadThread } from "./read-thread.js";

const liveDb = process.env.LIVE_DB_TESTS === "1" && process.env.DATABASE_URL ? describe : describe.skip;

liveDb("read_thread batch snapshot", () => {
  const accountIds = [randomUUID(), randomUUID()];
  const messageIds = [randomUUID(), randomUUID(), randomUUID()];
  let pool: ReturnType<typeof getPool>;

  beforeAll(async () => {
    pool = getPool();
    for (const id of accountIds) {
      await pool.query(`INSERT INTO public.imap_accounts
        (id,email_address,host,port,username,encrypted_password)
        VALUES ($1,$2,'imap.example.test',993,$2,$3)`, [id, `${id}@example.test`, Buffer.from([0])]);
      await pool.query(`INSERT INTO public.imap_folders(account_id,path,status,tracked,sync_priority,uidvalidity)
        VALUES($1,'INBOX','ACTIVE',true,1,88003)`, [id]);
    }
    for (let i = 0; i < messageIds.length; i += 1) {
      await pool.query(`INSERT INTO public.imap_messages
        (id,account_id,folder_path,uidvalidity,uid,internal_date,subject,rfc_message_id,message_id_normalized,window_status,body_fetched_at)
        VALUES($1,$2,'INBOX',88003,$3,now(),'original',$4,$5,'IN_WINDOW',now())`,
      [messageIds[i], accountIds[i === 2 ? 1 : 0], i + 1, `<${messageIds[i]}@example.test>`, `${messageIds[i]}@example.test`]);
      await pool.query(`INSERT INTO public.imap_message_bodies
        (message_id,raw_mime,raw_mime_sha256,raw_bytes,raw_truncated,body_text,fetched_at)
        VALUES($1,$2,$3,4,false,'body',now())`, [messageIds[i], Buffer.from("body"), "0".repeat(64)]);
    }
  });

  afterAll(async () => {
    if (pool) await pool.query("DELETE FROM public.imap_accounts WHERE id=ANY($1::uuid[])", [accountIds]);
    await closePool();
  });

  it("keeps threads and trust coherent during concurrent writes, then refreshes next request", async () => {
    let changed = false;
    let trustQueries = 0;
    const observedPool = {
      async connect() {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.includes("FROM public.imap_accounts a")) {
              trustQueries += 1;
              if (!changed) {
                changed = true;
                await pool.query("UPDATE public.imap_messages SET subject='changed',body_fetched_at=NULL WHERE id=$1", [messageIds[1]]);
              }
            }
            return result;
          },
          release: (error?: Error) => client.release(error)
        };
      }
    } as unknown as typeof pool;
    try {
      const batch = await runReadThread(observedPool, { message_ids: messageIds.slice(0, 2).map(id => id.toUpperCase()) });
      expect("threads" in batch).toBe(true);
      if (!("threads" in batch)) return;
      expect(batch.threads.map(t => "result" in t ? t.result.thread.subject : null)).toEqual(["original", "original"]);
      expect(batch.threads.map(t => "result" in t ? t.result.sync_trust.accounts[0].live_bodies_complete_pct : null)).toEqual([100, 100]);
      expect(trustQueries).toBe(1);
      const next = await runReadThread(pool, { message_id: messageIds[1] });
      expect("thread" in next).toBe(true);
      if (!("thread" in next)) return;
      expect(next.thread.subject).toBe("changed");
      expect(next.sync_trust.accounts[0].live_bodies_complete_pct).toBe(50);
    } finally {
      await pool.query("UPDATE public.imap_messages SET subject='original',body_fetched_at=now() WHERE id=$1", [messageIds[1]]);
    }
  });

  it("recovers a real SQL item error and keeps account-specific trust separate", async () => {
    let failed = false;
    const observedPool = {
      async connect() {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            if (!failed && sql.includes("WITH legacy_candidates") && values?.[2] === messageIds[1]) {
              failed = true;
              return client.query("SELECT 1 / 0");
            }
            return client.query(sql, values);
          },
          release: (error?: Error) => client.release(error)
        };
      }
    } as unknown as typeof pool;
    const batch = await runReadThread(observedPool, { message_ids: messageIds });
    expect("threads" in batch).toBe(true);
    if (!("threads" in batch)) return;
    const [first, broken, last] = batch.threads;
    expect("result" in first ? first.result.sync_trust.accounts.map(a => a.account_id) : null).toEqual([accountIds[0]]);
    expect("error" in broken ? broken.error.code : null).toBe("tool_failed");
    expect("result" in last ? last.result.sync_trust.accounts.map(a => a.account_id) : null).toEqual([accountIds[1]]);
  });
});
