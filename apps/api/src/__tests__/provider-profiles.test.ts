import { describe, expect, it } from "vitest";
import { getProviderProfile, listProviderProfiles } from "../provider-profiles.js";

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
