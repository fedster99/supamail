import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("API safety", () => {
  it("requires an API token while keeping health checks public", async () => {
    const source = await readFile(resolve(process.cwd(), "src/api.ts"), "utf8");

    expect(source).toContain("API_TOKEN is required to run the SupaMail API");
    expect(source).toContain('app.get("/health"');
    expect(source).toContain('if (c.req.path === "/health") return next()');
    expect(source).not.toContain("if (!config.API_TOKEN) return next()");
  });

  it("uses the SupaMail CLI name", async () => {
    const source = await readFile(resolve(process.cwd(), "src/cli.ts"), "utf8");

    expect(source).toContain('.name("supamail")');
    expect(source).not.toContain('.name("imap-to-supabase")');
  });
});
