import { describe, expect, it, vi } from "vitest";
import { resolveSmtpCreds } from "../smtp-client.js";
import type { ImapAccount } from "../types.js";

/**
 * SMTP credential resolution-order coverage for provider presets (email-008)
 * layered on the email-001 contract: explicit smtp_* columns → provider-profile
 * `smtpDefaults` → error. The crypto module is mocked so no real AES envelope is
 * needed; we only assert the resolved host/port/secure/username, never bytes.
 */

vi.mock("../crypto.js", () => ({
  decryptPassword: vi.fn(async () => "plaintext-secret")
}));

const config = { IMAP_ENCRYPTION_KEY: "0123456789abcdef" } as never;
const pool = {} as never;

/** A minimal account row; provider-specific fields are overridden per test. */
function account(overrides: Partial<ImapAccount>): ImapAccount {
  return {
    id: "acc-1",
    email_address: "user@example.test",
    provider_profile: "generic-imap",
    host: "imap.example.test",
    port: 993,
    secure: true,
    username: "user@example.test",
    encrypted_password: Buffer.from("x"),
    smtp_host: null,
    smtp_port: null,
    smtp_secure: null,
    smtp_username: null,
    encrypted_smtp_password: null,
    ...overrides
  } as ImapAccount;
}

describe("resolveSmtpCreds preset defaults (email-008)", () => {
  const cases = [
    { profile: "fastmail", host: "smtp.fastmail.com", port: 465, secure: true },
    { profile: "zoho", host: "smtp.zoho.com", port: 465, secure: true },
    { profile: "icloud", host: "smtp.mail.me.com", port: 587, secure: false },
    { profile: "yahoo", host: "smtp.mail.yahoo.com", port: 465, secure: true },
    // The existing email-001 rackspace defaults must still resolve unchanged.
    { profile: "rackspace", host: "secure.emailsrvr.com", port: 465, secure: true }
  ];

  for (const c of cases) {
    it(`resolves ${c.profile} SMTP defaults when smtp_* columns are null`, async () => {
      const creds = await resolveSmtpCreds(pool, config, account({ provider_profile: c.profile }));
      expect(creds.host).toBe(c.host);
      expect(creds.port).toBe(c.port);
      expect(creds.secure).toBe(c.secure);
      // Username falls back to the IMAP username; password to the IMAP secret.
      expect(creds.username).toBe("user@example.test");
      expect(creds.password).toBe("plaintext-secret");
    });
  }

  it("explicit smtp_host overrides the preset default (explicit wins)", async () => {
    const creds = await resolveSmtpCreds(
      pool,
      config,
      account({
        provider_profile: "fastmail",
        smtp_host: "smtp.custom.test",
        smtp_port: 2525,
        smtp_secure: false,
        smtp_username: "override@custom.test"
      })
    );
    expect(creds.host).toBe("smtp.custom.test");
    expect(creds.port).toBe(2525);
    expect(creds.secure).toBe(false);
    expect(creds.username).toBe("override@custom.test");
  });

  it("errors when neither explicit columns nor a preset supply a host (generic)", async () => {
    await expect(
      resolveSmtpCreds(pool, config, account({ provider_profile: "generic-imap" }))
    ).rejects.toThrow(/No SMTP host configured/);
  });
});
