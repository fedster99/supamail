import { describe, expect, it } from "vitest";
import { autodiscoverProfile, getProviderProfile, listProviderProfiles } from "../provider-profiles.js";

describe("provider profiles", () => {
  it("defaults unknown providers to generic IMAP", () => {
    expect(getProviderProfile("unknown").id).toBe("generic-imap");
  });

  it("prioritizes inbox and sent folders", () => {
    const profile = getProviderProfile("rackspace");
    expect(profile.priorityForFolder("INBOX")).toBeLessThan(profile.priorityForFolder("Archive"));
    expect(profile.priorityForFolder("Sent Items")).toBeLessThan(profile.priorityForFolder("Archive"));
  });

  it("excludes noisy folders but mirrors Drafts", () => {
    const profile = getProviderProfile("generic-imap");
    expect(profile.excludedReason("Trash")).toBe("excluded_trash");
    expect(profile.excludedReason("Junk", "\\Junk")).toBe("excluded_junk");
    expect(profile.excludedReason("Archive")).toBeNull();
    expect(profile.excludedReason("INBOX")).toBeNull();
    // Drafts are real user mail and ARE mirrored (not excluded).
    expect(profile.excludedReason("Drafts", "\\Drafts")).toBeNull();
    expect(profile.excludedReason("INBOX.Drafts")).toBeNull();
  });

  it("excludes All Mail by name and SPECIAL-USE", () => {
    const profile = getProviderProfile("generic-imap");
    expect(profile.excludedReason("All Mail")).toBe("excluded_all_mail");
    expect(profile.excludedReason("[Gmail]/All Mail")).toBe("excluded_all_mail");
    expect(profile.excludedReason("[Gmail].All Mail")).toBe("excluded_all_mail");
    expect(profile.excludedReason("Archive", "\\All")).toBe("excluded_all_mail");
  });

  it("lists supported profiles", () => {
    expect(listProviderProfiles().map((profile) => profile.id)).toContain("rackspace");
  });

  it("keeps provider-specific quirks on the profile", () => {
    const profile = getProviderProfile("rackspace");
    expect(profile.compatibilityStatus).toBe("profiled");
    expect(profile.knownQuirks.map((quirk) => quirk.id)).toContain("rackspace-inbox-inbox-alias");
  });
});

describe("provider presets (email-008)", () => {
  // Each preset must resolve the exact published IMAP + SMTP coordinates.
  const expected = {
    fastmail: {
      imap: { host: "imap.fastmail.com", port: 993, secure: true },
      smtp: { host: "smtp.fastmail.com", port: 465, secure: true }
    },
    zoho: {
      imap: { host: "imap.zoho.com", port: 993, secure: true },
      smtp: { host: "smtp.zoho.com", port: 465, secure: true }
    },
    icloud: {
      imap: { host: "imap.mail.me.com", port: 993, secure: true },
      smtp: { host: "smtp.mail.me.com", port: 587, secure: false }
    },
    yahoo: {
      imap: { host: "imap.mail.yahoo.com", port: 993, secure: true },
      smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true }
    }
  } as const;

  for (const [id, coords] of Object.entries(expected)) {
    it(`resolves ${id} IMAP + SMTP coordinates`, () => {
      const profile = getProviderProfile(id);
      expect(profile.id).toBe(id);
      expect(profile.compatibilityStatus).toBe("profiled");
      expect(profile.imapDefaults).toEqual(coords.imap);
      // smtpDefaults.host is a function of the IMAP host but a fixed submission host.
      expect(profile.smtpDefaults?.host("anything")).toBe(coords.smtp.host);
      expect(profile.smtpDefaults?.port).toBe(coords.smtp.port);
      expect(profile.smtpDefaults?.secure).toBe(coords.smtp.secure);
    });
  }

  it("registers all four presets alongside rackspace + generic", () => {
    const ids = listProviderProfiles().map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["generic-imap", "rackspace", "fastmail", "zoho", "icloud", "yahoo"])
    );
  });

  it("the generic profile carries no IMAP/SMTP defaults (explicit-only)", () => {
    const generic = getProviderProfile("generic-imap");
    expect(generic.imapDefaults).toBeUndefined();
    expect(generic.smtpDefaults).toBeUndefined();
  });
});

describe("email-domain autodiscovery (email-008)", () => {
  it("maps each provider's primary domain to its preset", () => {
    expect(autodiscoverProfile("alice@fastmail.com")?.id).toBe("fastmail");
    expect(autodiscoverProfile("bob@zoho.com")?.id).toBe("zoho");
    expect(autodiscoverProfile("carol@icloud.com")?.id).toBe("icloud");
    expect(autodiscoverProfile("dave@yahoo.com")?.id).toBe("yahoo");
  });

  it("collapses iCloud aliases (icloud/me/mac) to one preset", () => {
    expect(autodiscoverProfile("x@icloud.com")?.id).toBe("icloud");
    expect(autodiscoverProfile("x@me.com")?.id).toBe("icloud");
    expect(autodiscoverProfile("x@mac.com")?.id).toBe("icloud");
  });

  it("collapses Yahoo aliases (yahoo/ymail/rocketmail) to one preset", () => {
    expect(autodiscoverProfile("x@yahoo.com")?.id).toBe("yahoo");
    expect(autodiscoverProfile("x@ymail.com")?.id).toBe("yahoo");
    expect(autodiscoverProfile("x@rocketmail.com")?.id).toBe("yahoo");
  });

  it("is case-insensitive and accepts a bare domain", () => {
    expect(autodiscoverProfile("X@Fastmail.COM")?.id).toBe("fastmail");
    expect(autodiscoverProfile("ZOHO.com")?.id).toBe("zoho");
  });

  it("returns null for an unknown domain (caller keeps generic, explicit required)", () => {
    expect(autodiscoverProfile("someone@example.test")).toBeNull();
    expect(autodiscoverProfile("someone@gmail.com")).toBeNull();
    expect(autodiscoverProfile("")).toBeNull();
  });
});
