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

  it("compares bearer tokens with a constant-time primitive", async () => {
    const source = await readFile(resolve(process.cwd(), "src/api.ts"), "utf8");

    expect(source).toContain("timingSafeEqual");
    expect(source).not.toMatch(/header\s*!==\s*`Bearer/);
  });

  it("validates POST /accounts input with zod", async () => {
    const source = await readFile(resolve(process.cwd(), "src/api.ts"), "utf8");

    expect(source).toContain("CREATE_ACCOUNT_SCHEMA");
    expect(source).toContain("z.string().email()");
    expect(source).toContain("z.coerce.number().int().min(1).max(65535)");
  });

  it("installs a global onError that maps zod, host-validation, not-found, and unique-violation", async () => {
    const source = await readFile(resolve(process.cwd(), "src/api.ts"), "utf8");

    expect(source).toContain("app.onError");
    expect(source).toContain("HostValidationError");
    expect(source).toContain("NotFoundError");
    expect(source).toContain("23505");
    expect(source).toContain("ZodError");
  });

  it("gates POST /migrate behind ADMIN_TOKEN when set", async () => {
    const source = await readFile(resolve(process.cwd(), "src/api.ts"), "utf8");

    expect(source).toContain("ADMIN_TOKEN_BUFFER");
    expect(source).toContain('c.req.path === "/migrate"');
  });

  it("uses the SupaMail CLI name", async () => {
    const source = await readFile(resolve(process.cwd(), "src/cli.ts"), "utf8");

    expect(source).toContain('.name("supamail")');
    expect(source).not.toContain('.name("imap-to-supabase")');
  });
});
