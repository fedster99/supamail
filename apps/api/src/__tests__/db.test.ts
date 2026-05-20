import { describe, expect, it } from "vitest";
import { assertSessionConnectionUrl } from "../db.js";

describe("database connection guard", () => {
  it("allows direct Postgres URLs", () => {
    expect(() => assertSessionConnectionUrl("postgresql://postgres:pass@db.example.com:5432/postgres")).not.toThrow();
  });

  it("rejects Supabase transaction pooler URLs", () => {
    expect(() =>
      assertSessionConnectionUrl("postgresql://postgres:pass@aws-0-us-west-1.pooler.supabase.com:6543/postgres")
    ).toThrow(/advisory locks/);
  });
});
