export interface ProviderProfile {
  id: string;
  displayName: string;
  priorityForFolder(path: string, specialUse?: string | null): number;
  excludedReason(path: string, specialUse?: string | null): string | null;
}

function normalizedPath(path: string): string {
  return path.toLowerCase().replace(/^\\+/, "");
}

const noisyFolderFragments = [
  "spam",
  "junk",
  "trash",
  "deleted",
  "draft",
  "archive"
];

export const genericImapProfile: ProviderProfile = {
  id: "generic-imap",
  displayName: "Generic IMAP",
  priorityForFolder(path, specialUse) {
    const normalized = normalizedPath(specialUse || path);
    if (normalized.includes("inbox")) return 1;
    if (normalized.includes("sent")) return 5;
    return 100;
  },
  excludedReason(path, specialUse) {
    const normalized = normalizedPath(`${specialUse || ""} ${path}`);
    for (const fragment of noisyFolderFragments) {
      if (normalized.includes(fragment)) return `excluded_${fragment}`;
    }
    return null;
  }
};

export const rackspaceProfile: ProviderProfile = {
  ...genericImapProfile,
  id: "rackspace",
  displayName: "Rackspace Email",
  priorityForFolder(path, specialUse) {
    const normalized = normalizedPath(specialUse || path);
    if (path === "INBOX" || normalized.includes("inbox")) return 1;
    if (normalized.includes("sent")) return 5;
    return 100;
  }
};

const profiles = new Map<string, ProviderProfile>([
  [genericImapProfile.id, genericImapProfile],
  [rackspaceProfile.id, rackspaceProfile]
]);

export function getProviderProfile(id: string | null | undefined): ProviderProfile {
  return profiles.get(id || "") ?? genericImapProfile;
}

export function listProviderProfiles(): ProviderProfile[] {
  return [...profiles.values()];
}
