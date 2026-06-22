export interface ProviderProfile {
  id: string;
  displayName: string;
  compatibilityStatus: "generic-core" | "profiled";
  knownQuirks: ProviderQuirk[];
  priorityForFolder(path: string, specialUse?: string | null): number;
  excludedReason(path: string, specialUse?: string | null): string | null;
  /**
   * Default SMTP coordinates for the send path (email-001), used only when the
   * account row has no explicit smtp_* columns. Set ONLY for real, known
   * provider mappings — generic IMAP stays explicit-only (no speculative
   * heuristics). `host` is derived from the IMAP host so per-account hosts work.
   */
  smtpDefaults?: {
    host: (imapHost: string) => string;
    port: number;
    secure: boolean;
  };
}

export interface ProviderQuirk {
  id: string;
  description: string;
  handling: string;
}

function normalizedPath(path: string): string {
  return path.toLowerCase().replace(/^\\+/, "");
}

// Folders not mirrored by default: spam/junk/trash/deleted are noisy + transient.
// Drafts ARE mirrored (they are real user-authored mail), so "draft" is intentionally
// not in this list.
const noisyFolderFragments = [
  "spam",
  "junk",
  "trash",
  "deleted"
];

function isAllMail(path: string, specialUse?: string | null): boolean {
  const normalizedSpecialUse = normalizedPath(specialUse ?? "").trim();
  const normalizedFolder = normalizedPath(path).replace(/\s+/g, " ").trim();
  return normalizedSpecialUse === "all" || /(^|[/.])all\s*mail$/.test(normalizedFolder);
}

export const genericImapProfile: ProviderProfile = {
  id: "generic-imap",
  displayName: "Generic IMAP",
  compatibilityStatus: "generic-core",
  knownQuirks: [],
  priorityForFolder(path, specialUse) {
    const normalized = normalizedPath(specialUse || path);
    if (normalized.includes("inbox")) return 1;
    if (normalized.includes("sent")) return 5;
    return 100;
  },
  excludedReason(path, specialUse) {
    if (isAllMail(path, specialUse)) return "excluded_all_mail";
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
  compatibilityStatus: "profiled",
  // Rackspace submission is a single shared host on implicit TLS, regardless of
  // the per-account IMAP host. A real, known mapping (not a guess).
  smtpDefaults: { host: () => "secure.emailsrvr.com", port: 465, secure: true },
  knownQuirks: [
    {
      id: "rackspace-inbox-inbox-alias",
      description: "Some Rackspace accounts expose INBOX.INBOX as a duplicate alias for INBOX.",
      handling: "The sync engine excludes INBOX.INBOX only after mailbox metadata fingerprint verification."
    }
  ],
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
