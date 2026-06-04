import { describe, expect, it } from "vitest";
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
