import { describe, expect, it, vi } from "vitest";
import { assertSessionConnectionUrl, createPool } from "../db.js";

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
