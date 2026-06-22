export interface ProviderProfile {
  id: string;
  displayName: string;
  compatibilityStatus: "generic-core" | "profiled";
  knownQuirks: ProviderQuirk[];
  priorityForFolder(path: string, specialUse?: string | null): number;
  excludedReason(path: string, specialUse?: string | null): string | null;
  /**
   * Default IMAP coordinates for connect-time autodiscovery (email-008), used
   * only when the account is created without an explicit `host`. Set ONLY for
   * real, known provider mappings — generic IMAP stays explicit-only (no
   * speculative heuristics). A fixed host string (these are single shared
   * submission/access hosts, independent of the local-part).
   */
  imapDefaults?: {
    host: string;
    port: number;
    secure: boolean;
  };
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

/**
 * IMAP long-tail presets (email-008, ADR 0021). Each carries BOTH the IMAP
 * access coordinates (`imapDefaults`) and the SMTP submission coordinates
 * (`smtpDefaults`) so connect-mailbox can fill host/port/secure from the email
 * address with no manual entry. All values are the providers' published, stable
 * single-host coordinates — not guesses. They behave as generic-core IMAP
 * otherwise (no known sync quirks), so they inherit genericImapProfile.
 */

// Fastmail: imap.fastmail.com:993 (implicit TLS) / smtp.fastmail.com:465 (implicit TLS).
export const fastmailProfile: ProviderProfile = {
  ...genericImapProfile,
  id: "fastmail",
  displayName: "Fastmail",
  compatibilityStatus: "profiled",
  imapDefaults: { host: "imap.fastmail.com", port: 993, secure: true },
  smtpDefaults: { host: () => "smtp.fastmail.com", port: 465, secure: true }
};

// Zoho Mail: imap.zoho.com:993 (implicit TLS) / smtp.zoho.com:465 (implicit TLS).
export const zohoProfile: ProviderProfile = {
  ...genericImapProfile,
  id: "zoho",
  displayName: "Zoho Mail",
  compatibilityStatus: "profiled",
  imapDefaults: { host: "imap.zoho.com", port: 993, secure: true },
  smtpDefaults: { host: () => "smtp.zoho.com", port: 465, secure: true }
};

// iCloud Mail: imap.mail.me.com:993 (implicit TLS) / smtp.mail.me.com:587 (STARTTLS).
// Requires an app-specific password (Apple does not allow the primary password
// over IMAP/SMTP); that is a credential concern handled by the caller, not here.
export const icloudProfile: ProviderProfile = {
  ...genericImapProfile,
  id: "icloud",
  displayName: "iCloud Mail",
  compatibilityStatus: "profiled",
  imapDefaults: { host: "imap.mail.me.com", port: 993, secure: true },
  smtpDefaults: { host: () => "smtp.mail.me.com", port: 587, secure: false }
};

// Yahoo Mail: imap.mail.yahoo.com:993 (implicit TLS) / smtp.mail.yahoo.com:465
// (implicit TLS). Requires an app password (third-party access is app-password
// only); again a credential concern for the caller.
export const yahooProfile: ProviderProfile = {
  ...genericImapProfile,
  id: "yahoo",
  displayName: "Yahoo Mail",
  compatibilityStatus: "profiled",
  imapDefaults: { host: "imap.mail.yahoo.com", port: 993, secure: true },
  smtpDefaults: { host: () => "smtp.mail.yahoo.com", port: 465, secure: true }
};

const profiles = new Map<string, ProviderProfile>([
  [genericImapProfile.id, genericImapProfile],
  [rackspaceProfile.id, rackspaceProfile],
  [fastmailProfile.id, fastmailProfile],
  [zohoProfile.id, zohoProfile],
  [icloudProfile.id, icloudProfile],
  [yahooProfile.id, yahooProfile]
]);

export function getProviderProfile(id: string | null | undefined): ProviderProfile {
  return profiles.get(id || "") ?? genericImapProfile;
}

export function listProviderProfiles(): ProviderProfile[] {
  return [...profiles.values()];
}

/**
 * Map an email domain to a preset profile id (email-008). Common provider
 * aliases collapse to one preset: me.com/icloud.com/mac.com → iCloud,
 * ymail.com/rocketmail.com → Yahoo. The lookup is a static map only — NO
 * network MX/autoconfig probing. Returns null when no preset matches (the
 * caller then keeps generic IMAP and requires explicit coordinates).
 */
const DOMAIN_TO_PROFILE: ReadonlyMap<string, string> = new Map([
  ["fastmail.com", fastmailProfile.id],
  ["fastmail.fm", fastmailProfile.id],
  ["zoho.com", zohoProfile.id],
  ["zohomail.com", zohoProfile.id],
  ["icloud.com", icloudProfile.id],
  ["me.com", icloudProfile.id],
  ["mac.com", icloudProfile.id],
  ["yahoo.com", yahooProfile.id],
  ["ymail.com", yahooProfile.id],
  ["rocketmail.com", yahooProfile.id]
]);

/**
 * Autodiscover the provider profile for a mailbox email address (or bare
 * domain) from its domain. Returns the matched {@link ProviderProfile} (which
 * carries IMAP + SMTP coordinates) or null when no preset matches — callers
 * then fall back to generic IMAP with explicit coordinates required. No network
 * access; a pure static-map lookup.
 */
export function autodiscoverProfile(emailOrDomain: string): ProviderProfile | null {
  const at = emailOrDomain.lastIndexOf("@");
  const domain = (at >= 0 ? emailOrDomain.slice(at + 1) : emailOrDomain).trim().toLowerCase();
  if (!domain) return null;
  const id = DOMAIN_TO_PROFILE.get(domain);
  return id ? (profiles.get(id) ?? null) : null;
}
