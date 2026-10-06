import { describe, expect, it, vi } from "vitest";
import { assertSessionConnectionUrl, createPool, isSupabaseSessionPoolerUrl } from "../db.js";

describe("database connection guard", () => {
  it("allows direct Postgres URLs", () => {
    expect(() => assertSessionConnectionUrl("postgresql://postgres:pass@db.example.com:5432/postgres")).not.toThrow();
  });

  it("allows Supabase session pooler URLs", () => {
    expect(() =>
      assertSessionConnectionUrl("postgresql://postgres.ref:pass@aws-0-us-west-2.pooler.supabase.com:5432/postgres")
    ).not.toThrow();
  });

  it("rejects Supabase transaction pooler URLs", () => {
    expect(() =>
      assertSessionConnectionUrl("postgresql://postgres:pass@aws-0-us-west-1.pooler.supabase.com:6543/postgres")
    ).toThrow(/advisory locks/);
  });
});

describe("createPool size", () => {
  const URL = "postgresql://postgres:pass@db.example.com:5432/postgres";
  const maxOf = (pool: unknown) => (pool as { options: { max?: number } }).options.max;

  it("defaults max connections to 10 when only DATABASE_URL is given", async () => {
    const pool = createPool({ DATABASE_URL: URL });
    try {
      expect(maxOf(pool)).toBe(10);
    } finally {
      await pool.end();
    }
  });

  it("honors DATABASE_POOL_MAX", async () => {
    const pool = createPool({ DATABASE_URL: URL, DATABASE_POOL_MAX: 25 });
    try {
      expect(maxOf(pool)).toBe(25);
    } finally {
      await pool.end();
    }
  });
});

describe("createPool runtime errors", () => {
  const URL = "postgresql://postgres:pass@db.example.com:5432/postgres";

  it("keeps a terminated idle client from becoming an uncaught process exception", async () => {
    const error = Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01"
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = createPool({ DATABASE_URL: URL });
    try {
      expect(() => pool.emit("error", error)).not.toThrow();
      expect(log).toHaveBeenCalledWith(JSON.stringify({
        event: "database.pool.idle_client_error",
        error: {
          message: error.message,
          code: "57P01",
          stack: error.stack
        }
      }));
    } finally {
      log.mockRestore();
      await pool.end();
    }
  });
});

describe("createPool server-side TCP liveness", () => {
  it("configures direct connections and skips the session pooler, where probes cannot reach the worker", async () => {
    const direct = createPool({ DATABASE_URL: "postgresql://user@localhost:5432/db" });
    const pooler = createPool({
      DATABASE_URL: "postgresql://postgres.ref@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
    });
    try {
      expect(direct.listenerCount("connect")).toBe(1);
      expect(pooler.listenerCount("connect")).toBe(0);
      expect(isSupabaseSessionPoolerUrl(undefined)).toBe(false);
      expect(isSupabaseSessionPoolerUrl("not a url")).toBe(false);
    } finally {
      await direct.end();
      await pooler.end();
    }
  });
});

describe("applyPublicMigrations", () => {
  it("commits each migration with its record and stops at the first failure", async () => {
    const { applyPublicMigrations, readPublicMigrationFiles } = await import("../db.js");
    const migrations = await readPublicMigrationFiles();
    const ran: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        ran.push({ text, values });
        if (text.startsWith("SELECT id FROM supamail_meta.public_migrations")) return { rows: [] };
        if (text === migrations[1].sql) throw new Error("second migration failed");
        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = { connect: async () => client } as unknown as Parameters<typeof applyPublicMigrations>[0];

    await expect(applyPublicMigrations(pool)).rejects.toThrow(/second migration failed/);
    const recorded = ran
      .filter((entry) => entry.text.startsWith("INSERT INTO supamail_meta.public_migrations"))
      .map((entry) => entry.values?.[0]);
    expect(recorded).toEqual([migrations[0].id]);
    expect(ran.map((entry) => entry.text)).toContain("ROLLBACK");
    expect(ran.map((entry) => entry.text)).not.toContain(migrations[2].sql);
  });
});
