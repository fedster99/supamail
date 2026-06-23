import { describe, expect, it } from "vitest";
import {
  genericImapProfile,
  resolveSpecialUseFolder,
  type SpecialUseRole
} from "../provider-profiles.js";

/**
 * Parametrized coverage for the ONE role-keyed special-use folder resolver (CC-2).
 * The send/mutate/drafts paths each used to re-encode "find the Sent/Trash/Drafts
 * mailbox" with a SUBTLY different fallback: Sent falls back via the provider
 * profile's "sent" priority winner, while Trash/Drafts ignore the profile and match
 * the leaf name. This reproduces each role's EXACT historical behavior in one place
 * (the per-resolver wrappers in smtp-client/mailbox-mutations/drafts delegate here);
 * those per-resolver tests stay green unchanged.
 */

const ROLES: Array<{
  role: SpecialUseRole;
  specialUse: string;
  conventional: string;
}> = [
  { role: "sent", specialUse: "\\Sent", conventional: "Sent" },
  { role: "trash", specialUse: "\\Trash", conventional: "Trash" },
  { role: "drafts", specialUse: "\\Drafts", conventional: "Drafts" }
];

describe("resolveSpecialUseFolder", () => {
  for (const { role, specialUse, conventional } of ROLES) {
    it(`prefers the ${specialUse} special-use mailbox for role "${role}"`, () => {
      const boxes = [
        { path: "INBOX", specialUse: null },
        { path: "Some Folder", specialUse }
      ];
      expect(resolveSpecialUseFolder(boxes, role, genericImapProfile)).toBe("Some Folder");
    });

    it(`falls back to the conventional "${conventional}" when nothing matches for role "${role}"`, () => {
      expect(
        resolveSpecialUseFolder([{ path: "INBOX", specialUse: null }], role, genericImapProfile)
      ).toBe(conventional);
    });
  }

  // The Trash/Drafts roles fall back by LEAF NAME (profile ignored).
  it("trash falls back to a folder literally named Trash (leaf-name, profile ignored)", () => {
    expect(
      resolveSpecialUseFolder([{ path: "INBOX/Trash", specialUse: null }], "trash", genericImapProfile)
    ).toBe("INBOX/Trash");
  });

  it("drafts falls back to a folder literally named Drafts (leaf-name, profile ignored)", () => {
    expect(
      resolveSpecialUseFolder([{ path: "INBOX.Drafts", specialUse: null }], "drafts", genericImapProfile)
    ).toBe("INBOX.Drafts");
  });

  // The Sent role's fallback DIVERGES: it consults the provider profile's
  // priority winner (priority 5), NOT a leaf-name match. A folder the generic
  // profile scores as "sent" (priority 5) wins even when its leaf name is not
  // "sent" and there is no special-use attribute. This is the preserved
  // inconsistency the shared resolver makes visible in one place.
  it("sent falls back via the profile priority winner, not leaf-name", () => {
    // "Sent Items" — generic profile's priorityForFolder returns 5 (matches "sent").
    expect(
      resolveSpecialUseFolder([{ path: "Sent Items", specialUse: null }], "sent", genericImapProfile)
    ).toBe("Sent Items");
  });

  it("sent does NOT use the Trash/Drafts leaf-name strategy (a Trash-named folder never wins sent)", () => {
    // No special-use, no priority-5 folder → sent falls through to conventional "Sent",
    // proving sent ignores the leaf-name fallback that trash/drafts use.
    expect(
      resolveSpecialUseFolder([{ path: "INBOX/Trash", specialUse: null }], "sent", genericImapProfile)
    ).toBe("Sent");
  });
});
