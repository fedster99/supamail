import { describe, expect, it, vi } from "vitest";
import { MirrorRepository } from "../repository.js";
import type { AppConfig } from "../config.js";
import type { PgPool } from "../db.js";
import type { ImapAccount } from "../types.js";

function scheduler(count: number, limit: number) {
  let now = 0;
  let cursor = 0;
  const folders = Array.from({ length: count }, (_,index) => ({
    id: String(index), path: `RR-${String(index).padStart(2,"0")}`,
    nextDue: 0
  }));
  const pool = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("UPDATE public.imap_accounts SET folder_rr_cursor")) {
      cursor = Number(values?.[1]);
      return { rows: [] };
    }
    if (sql.includes("sync_priority <= $2")) return { rows: [] };
    if (sql.includes("sync_priority > $2")) {
      const rows = folders.map(f => ({ ...f, sync_due: f.nextDue <= now }));
      // Emulate PostgreSQL's due filter, including the old shrinking row set.
      return { rows: sql.includes("AND (next_sync_due_at IS NULL")
        ? rows.filter(f => f.sync_due) : rows };
    }
    throw new Error("unexpected scheduling query");
  }) };
  const repository = new MirrorRepository(pool as unknown as PgPool, {
    PRIORITY_CUTOFF: 10, MAX_PRIORITY_FOLDERS_PER_CYCLE: 1,
    MAX_RR_FOLDERS_PER_CYCLE: limit
  } as AppConfig);
  vi.spyOn(repository,"getAccount").mockImplementation(async () => ({ folder_rr_cursor: cursor } as ImapAccount));
  return { repository, folders, advance(ms: number) { now += ms; },
    complete(ids: string[]) { for (const f of folders) if (ids.includes(f.id)) f.nextDue = now + 300_000; } };
}

describe("round-robin scheduling", () => {
  it("does not shift the cursor when an earlier folder becomes not due", async () => {
    const h = scheduler(3,1);
    const first = await h.repository.getFoldersDueForSync("mailbox");
    expect(first.map(f=>f.path)).toEqual(["RR-00"]);
    h.complete(first.map(f=>f.id));
    expect((await h.repository.getFoldersDueForSync("mailbox")).map(f=>f.path)).toEqual(["RR-01"]);
  });

  it("visits every folder under a poll interval shorter than its due interval", async () => {
    const h = scheduler(40,5), seen = new Set<string>();
    for (let cycle=0;cycle<16;cycle++) {
      const selected = await h.repository.getFoldersDueForSync("mailbox");
      expect(selected).toHaveLength(5);
      selected.forEach(f=>seen.add(f.id));
      h.complete(selected.map(f=>f.id));
      h.advance(285_000);
    }
    expect(seen.size).toBe(40);
  });

  it("advances selection even when a selected folder never succeeds", async () => {
    const h = scheduler(3,1), seen = new Set<string>();
    for(let cycle=0;cycle<3;cycle++) (await h.repository.getFoldersDueForSync("mailbox")).forEach(f=>seen.add(f.id));
    expect(seen.size).toBe(3);
  });

  it("keeps ordinary position when preferred discovery work fills the budget", async () => {
    const h = scheduler(4,1);
    expect((await h.repository.getFoldersDueForSync("mailbox",["RR-03"])).map(f=>f.path)).toEqual(["RR-03"]);
    h.complete(["3"]);
    expect((await h.repository.getFoldersDueForSync("mailbox")).map(f=>f.path)).toEqual(["RR-00"]);
    expect((await h.repository.getFoldersDueForSync("mailbox",["RR-03"])).map(f=>f.path)).toEqual(["RR-01"]);
  });

  it("leaves a completely not-due round unchanged until it becomes due", async () => {
    const h = scheduler(3,1);
    h.complete(["0","1","2"]);
    expect(await h.repository.getFoldersDueForSync("mailbox")).toEqual([]);
    h.advance(300_000);
    expect((await h.repository.getFoldersDueForSync("mailbox")).map(f=>f.path)).toEqual(["RR-00"]);
  });
});
