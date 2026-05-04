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

  it("excludes noisy folders", () => {
    const profile = getProviderProfile("generic-imap");
    expect(profile.excludedReason("Trash")).toBe("excluded_trash");
    expect(profile.excludedReason("INBOX")).toBeNull();
  });

  it("lists supported profiles", () => {
    expect(listProviderProfiles().map((profile) => profile.id)).toContain("rackspace");
  });
});
