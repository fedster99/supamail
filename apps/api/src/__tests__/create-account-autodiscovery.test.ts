import { describe, expect, it, vi, beforeEach } from "vitest";
import { MirrorRepository } from "../repository.js";
import type { AppConfig } from "../config.js";
import type { PgPool } from "../db.js";

/**
 * Email-domain autodiscovery wiring in createAccount (email-008): when the
 * caller omits host/port, the IMAP coordinates + provider_profile are filled
 * from the email domain's preset; explicit input always wins; an unknown domain
 * with no explicit host is rejected (generic IMAP stays explicit-only). The
 * host-SSRF guard and crypto are mocked so the test is pure (no DNS, no real
 * envelope) and only the INSERT params are asserted.
 */

vi.mock("../host-validation.js", () => ({
  assertSafeImapTarget: vi.fn(async () => undefined)
}));

vi.mock("../crypto.js", () => ({
  encryptPassword: vi.fn(async () => Buffer.from("enc"))
}));

const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef", SYNC_MAX_ACCOUNTS: 100, BODY_FETCH_POLICY: "lazy" } as unknown as AppConfig;

/** Capture the INSERT params; the SELECT count returns 0 so the cap never trips. */
function stubPool(): { pool: PgPool; insertParams: () => unknown[] } {
  let captured: unknown[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
      if (sql.includes("INSERT INTO public.imap_accounts")) {
        captured = params ?? [];
        return { rows: [{ id: "acc-1", email_address: String(params?.[0]) }] };
      }
      return { rows: [] };
    })
  } as unknown as PgPool;
  return { pool, insertParams: () => captured };
}

// INSERT column order: email, provider_profile, host, port, secure, ...
const COL = { email: 0, profile: 1, host: 2, port: 3, secure: 4 };

describe("createAccount email-domain autodiscovery (email-008)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fills IMAP host/port/secure + provider_profile from the domain when host is omitted", async () => {
    const { pool, insertParams } = stubPool();
    const repo = new MirrorRepository(pool, config);
    await repo.createAccount({
      emailAddress: "alice@fastmail.com",
      username: "alice@fastmail.com",
      password: "secret"
    });
    const p = insertParams();
    expect(p[COL.profile]).toBe("fastmail");
    expect(p[COL.host]).toBe("imap.fastmail.com");
    expect(p[COL.port]).toBe(993);
    expect(p[COL.secure]).toBe(true);
  });

  it("resolves the iCloud STARTTLS-SMTP preset from a me.com address", async () => {
    const { pool, insertParams } = stubPool();
    const repo = new MirrorRepository(pool, config);
    await repo.createAccount({
      emailAddress: "carol@me.com",
      username: "carol@me.com",
      password: "secret"
    });
    const p = insertParams();
    expect(p[COL.profile]).toBe("icloud");
    expect(p[COL.host]).toBe("imap.mail.me.com");
  });

  it("lets an explicit host/profile override autodiscovery (explicit wins)", async () => {
    const { pool, insertParams } = stubPool();
    const repo = new MirrorRepository(pool, config);
    await repo.createAccount({
      emailAddress: "bob@yahoo.com",
      host: "imap.self-hosted.test",
      port: 993,
      username: "bob",
      password: "secret",
      providerProfile: "generic-imap"
    });
    const p = insertParams();
    expect(p[COL.host]).toBe("imap.self-hosted.test");
    expect(p[COL.profile]).toBe("generic-imap");
  });

  it("supplies a named preset's coordinates when --profile is set and host is omitted", async () => {
    const { pool, insertParams } = stubPool();
    const repo = new MirrorRepository(pool, config);
    // Domain (a self-hosted vanity domain) does NOT match any preset; the explicit
    // --profile fastmail is what supplies the coordinates.
    await repo.createAccount({
      emailAddress: "alice@vanity.example",
      username: "alice@fastmail.com",
      password: "secret",
      providerProfile: "fastmail"
    });
    const p = insertParams();
    expect(p[COL.profile]).toBe("fastmail");
    expect(p[COL.host]).toBe("imap.fastmail.com");
    expect(p[COL.port]).toBe(993);
    expect(p[COL.secure]).toBe(true);
  });

  it("resolves the zoho US-DC coordinates from --profile zoho with no host (M1)", async () => {
    const { pool, insertParams } = stubPool();
    const repo = new MirrorRepository(pool, config);
    // `@zoho.com` is no longer autodiscovered (multi-DC); the US-DC coordinates are
    // reachable only via the explicit --profile zoho.
    await repo.createAccount({
      emailAddress: "bob@zoho.com",
      username: "bob@zoho.com",
      password: "secret",
      providerProfile: "zoho"
    });
    const p = insertParams();
    expect(p[COL.profile]).toBe("zoho");
    expect(p[COL.host]).toBe("imap.zoho.com");
    expect(p[COL.port]).toBe(993);
    expect(p[COL.secure]).toBe(true);
  });

  it("rejects a host-less @zoho.com with no --profile (multi-DC, not autodiscovered)", async () => {
    const { pool } = stubPool();
    const repo = new MirrorRepository(pool, config);
    await expect(
      repo.createAccount({
        emailAddress: "bob@zoho.com",
        username: "bob@zoho.com",
        password: "secret"
      })
    ).rejects.toThrow(/No IMAP host\/port/);
  });

  it("lets an explicit host win over a named --profile preset", async () => {
    const { pool, insertParams } = stubPool();
    const repo = new MirrorRepository(pool, config);
    await repo.createAccount({
      emailAddress: "alice@fastmail.com",
      host: "imap.self-hosted.test",
      port: 1993,
      username: "alice",
      password: "secret",
      providerProfile: "fastmail"
    });
    const p = insertParams();
    // Explicit host/port win; the stored profile id is still the named preset.
    expect(p[COL.host]).toBe("imap.self-hosted.test");
    expect(p[COL.port]).toBe(1993);
    expect(p[COL.profile]).toBe("fastmail");
  });

  it("rejects an unknown domain with no explicit host (generic stays explicit-only)", async () => {
    const { pool } = stubPool();
    const repo = new MirrorRepository(pool, config);
    await expect(
      repo.createAccount({
        emailAddress: "dave@unknown-provider.test",
        username: "dave",
        password: "secret"
      })
    ).rejects.toThrow(/No IMAP host\/port/);
  });
});
