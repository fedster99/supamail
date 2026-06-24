import { describe, expect, it } from "vitest";
import { resolveImapCoords } from "../repository.js";

/**
 * Direct-call coverage for the IMAP coordinate resolver (email-008, ADR 0021), the
 * twin of resolveSmtpCreds (smtp-creds.test.ts). Precedence: explicit host/port/secure
 * → an explicitly-named non-generic preset's imapDefaults → email-domain
 * autodiscovery → error. Asserting the returned object (not positional INSERT
 * columns), so this is decoupled from SQL column order. The create-account
 * autodiscovery test still covers the createAccount wiring end-to-end.
 */

describe("resolveImapCoords", () => {
  it("fills host/port/secure + provider_profile from the domain when host is omitted", () => {
    const coords = resolveImapCoords({
      emailAddress: "alice@fastmail.com"
    });
    expect(coords.providerProfile).toBe("fastmail");
    expect(coords.host).toBe("imap.fastmail.com");
    expect(coords.port).toBe(993);
    expect(coords.secure).toBe(true);
  });

  it("collapses an iCloud alias domain (me.com) to the iCloud preset", () => {
    const coords = resolveImapCoords({ emailAddress: "carol@me.com" });
    expect(coords.providerProfile).toBe("icloud");
    expect(coords.host).toBe("imap.mail.me.com");
  });

  it("supplies a named preset's coordinates when --profile is set and host is omitted", () => {
    // The vanity domain matches no preset; the explicit --profile fastmail supplies
    // the coordinates (named preset BEATS the domain guess).
    const coords = resolveImapCoords({
      emailAddress: "alice@vanity.example",
      providerProfile: "fastmail"
    });
    expect(coords.providerProfile).toBe("fastmail");
    expect(coords.host).toBe("imap.fastmail.com");
    expect(coords.port).toBe(993);
    expect(coords.secure).toBe(true);
  });

  it("resolves the zoho US-DC coordinates only via the explicit --profile zoho", () => {
    const coords = resolveImapCoords({
      emailAddress: "bob@zoho.com",
      providerProfile: "zoho"
    });
    expect(coords.providerProfile).toBe("zoho");
    expect(coords.host).toBe("imap.zoho.com");
    expect(coords.port).toBe(993);
    expect(coords.secure).toBe(true);
  });

  it("lets an explicit host/port win over a named --profile preset (explicit wins)", () => {
    const coords = resolveImapCoords({
      emailAddress: "alice@fastmail.com",
      host: "imap.self-hosted.test",
      port: 1993,
      providerProfile: "fastmail"
    });
    expect(coords.host).toBe("imap.self-hosted.test");
    expect(coords.port).toBe(1993);
    // The stored profile id is still the named preset.
    expect(coords.providerProfile).toBe("fastmail");
  });

  it("lets an explicit host/profile override autodiscovery", () => {
    const coords = resolveImapCoords({
      emailAddress: "bob@yahoo.com",
      host: "imap.self-hosted.test",
      port: 993,
      providerProfile: "generic-imap"
    });
    expect(coords.host).toBe("imap.self-hosted.test");
    expect(coords.providerProfile).toBe("generic-imap");
  });

  it("defaults secure to true when an explicit host omits it", () => {
    const coords = resolveImapCoords({
      emailAddress: "dave@self.test",
      host: "imap.self.test",
      port: 993
    });
    expect(coords.secure).toBe(true);
    expect(coords.providerProfile).toBe("generic-imap");
  });

  it("rejects a host-less @zoho.com with no --profile (multi-DC, not autodiscovered)", () => {
    expect(() =>
      resolveImapCoords({ emailAddress: "bob@zoho.com" })
    ).toThrow(/No IMAP host\/port/);
  });

  it("rejects an unknown domain with no explicit host (generic stays explicit-only)", () => {
    expect(() =>
      resolveImapCoords({ emailAddress: "dave@unknown-provider.test" })
    ).toThrow(/No IMAP host\/port/);
  });
});
