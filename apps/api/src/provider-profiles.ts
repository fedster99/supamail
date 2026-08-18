export interface ProviderProfile {
  id: string;
  displayName: string;
  compatibilityStatus: "generic-core" | "profiled";
  knownQuirks: ProviderQuirk[];
  priorityForFolder(path: string, specialUse?: string | null, delimiter?: string | null): number;
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

const sentFolderLeafNames = new Set(["sent", "sent items", "sent mail", "sent messages"]);

function folderLeaf(path: string, delimiter?: string | null): string {
  const normalized = normalizedPath(path);
  const separator = delimiter && delimiter.length > 0 ? delimiter.toLowerCase() : null;
  const leaf = separator
    ? normalized.slice(normalized.lastIndexOf(separator) + separator.length)
    : normalized.split(/[/.]/).pop() ?? "";
  return leaf.replace(/\s+/g, " ").trim();
}

function isSentFolder(
  path: string,
  specialUse?: string | null,
  delimiter?: string | null
): boolean {
  if (normalizedPath(specialUse ?? "").trim() === "sent") return true;
  return sentFolderLeafNames.has(folderLeaf(path, delimiter));
}

export const genericImapProfile: ProviderProfile = {
  id: "generic-imap",
  displayName: "Generic IMAP",
  compatibilityStatus: "generic-core",
  knownQuirks: [],
  priorityForFolder(path, specialUse, delimiter) {
    const normalized = normalizedPath(specialUse || path);
    // IMAP hierarchy names commonly prefix every child with `INBOX.`. Only the
    // exact inbox role belongs in the hottest lane; treating every descendant
    // as Inbox can consume the bounded priority set and starve the real Sent
    // folder that outbound reconciliation depends on.
    if (normalized === "inbox") return 1;
    if (isSentFolder(path, specialUse, delimiter)) return 5;
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
  priorityForFolder(path, specialUse, delimiter) {
    const normalized = normalizedPath(specialUse || path);
    if (normalized === "inbox") return 1;
    if (isSentFolder(path, specialUse, delimiter)) return 5;
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

// Zoho Mail (US datacenter): imap.zoho.com:993 (implicit TLS) / smtp.zoho.com:465
// (implicit TLS). Zoho is MULTI-DATACENTER (US/EU/IN/AU/CN) and the email domain
// does NOT reveal which DC an account lives in, so `@zoho.com` is deliberately NOT
// in DOMAIN_TO_PROFILE (it cannot be autodiscovered safely). These US-DC
// coordinates are reachable only via an explicit `--profile zoho`; EU/IN/AU/CN
// users pass explicit `--host`/`--smtp-host` (`.eu`/`.in`/`.com.au`/`.zoho.com.cn`).
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
// Username note: iCloud IMAP expects the bare local-part (e.g. `alice`) while SMTP
// expects the full address (`alice@icloud.com`) — also a caller credential concern,
// not encoded in these coordinates.
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
 *
 * Zoho is deliberately NOT here: it is multi-datacenter (US/EU/IN/AU/CN) and the
 * email domain does not reveal the DC, so `@zoho.com` cannot be autodiscovered
 * safely (the US-DC coordinates are wrong for EU/IN/AU/CN accounts). US-DC users
 * select `--profile zoho`; other DCs pass explicit `--host`/`--smtp-host`.
 */
const DOMAIN_TO_PROFILE: ReadonlyMap<string, string> = new Map([
  ["fastmail.com", fastmailProfile.id],
  ["fastmail.fm", fastmailProfile.id],
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

// ---------------------------------------------------------------------------
// One role-keyed special-use folder resolver (CC-2).
// ---------------------------------------------------------------------------

/** A well-known IMAP role a caller wants to address (file Sent / move to Trash /
 * APPEND a Draft). The send/mutate/drafts paths each resolved their own folder by
 * re-encoding the same special-use → fallback → conventional-name precedence; this
 * is the single home for that precedence. */
export type SpecialUseRole = "sent" | "trash" | "drafts";

/**
 * The Drafts identity VOCABULARY, single-sourced so the in-memory role resolver
 * ({@link SPECIAL_USE_ROLES}.drafts) and the SQL `draftFolderPaths` (drafts.ts)
 * can never drift on "what names a Drafts folder." Only the VOCABULARY is shared;
 * the two QUERIES stay deliberately distinct (the resolver matches a live LIST, the
 * SQL matches the mirrored folder table). All tokens are lowercased for the
 * case-insensitive comparisons both sides do.
 *   - `specialUse`   the RFC 6154 attribute (`\drafts`, as imapflow lowercases it).
 *   - `leafName`     the conventional leaf name a Drafts folder ends in.
 *   - `conventional` the fallback path used when nothing else matches.
 */
export const DRAFTS_VOCABULARY = {
  specialUse: "\\drafts",
  leafName: "drafts",
  conventional: "Drafts"
} as const;

interface SpecialUseRoleSpec {
  /** The RFC 6154 special-use attribute, lowercased (e.g. "\\sent"). */
  specialUse: string;
  /** The conventional folder name used when nothing else matches (e.g. "Sent"). */
  conventional: string;
  /**
   * The per-role SECONDARY fallback, applied only when the server advertises no
   * matching special-use mailbox. This is where the three historical resolvers
   * deliberately DIVERGED and that divergence is preserved here verbatim:
   *   - "sent"   used `profile.priorityForFolder(path, specialUse) === 5`
   *   - "trash"/"drafts" ignored the profile and matched the leaf name
   * Returns the chosen folder path, or null to fall through to `conventional`.
   *
   * NOTE (future deliberate alignment): the Sent role consults the provider
   * profile while Trash/Drafts do not. That inconsistency is intentional to keep
   * this a behavior-preserving extraction; aligning all three on one strategy is a
   * follow-up that would CHANGE behavior and must be done knowingly.
   */
  fallback: (
    mailboxes: Array<{ path: string; specialUse?: string | null; delimiter?: string | null }>,
    profile: ProviderProfile
  ) => string | null;
}

/** Leaf-name match used by the Trash/Drafts fallback: the last path segment,
 * using the advertised delimiter when available, lowercased, equals `name`. */
function byLeafName(
  mailboxes: Array<{ path: string; specialUse?: string | null; delimiter?: string | null }>,
  name: string
): string | null {
  const found = mailboxes.find((m) => folderLeaf(m.path, m.delimiter) === name);
  return found ? found.path : null;
}

const SPECIAL_USE_ROLES: Record<SpecialUseRole, SpecialUseRoleSpec> = {
  // Sent falls back via the provider profile's "sent" priority winner (priority 5).
  sent: {
    specialUse: "\\sent",
    conventional: "Sent",
    fallback: (mailboxes, profile) => {
      const found = mailboxes.find(
        (m) => profile.priorityForFolder(m.path, m.specialUse, m.delimiter) === 5
      );
      return found ? found.path : null;
    }
  },
  // Trash falls back via a folder literally named "trash" (profile ignored).
  trash: {
    specialUse: "\\trash",
    conventional: "Trash",
    fallback: (mailboxes) => byLeafName(mailboxes, "trash")
  },
  // Drafts falls back via a folder literally named "drafts" (profile ignored). The
  // vocabulary is shared with the SQL draftFolderPaths (DRAFTS_VOCABULARY).
  drafts: {
    specialUse: DRAFTS_VOCABULARY.specialUse,
    conventional: DRAFTS_VOCABULARY.conventional,
    fallback: (mailboxes) => byLeafName(mailboxes, DRAFTS_VOCABULARY.leafName)
  }
};

/**
 * Resolve the mailbox that plays `role` (Sent / Trash / Drafts): the matching
 * RFC 6154 special-use mailbox if the server advertises one, else the role's
 * SECONDARY fallback (see {@link SpecialUseRoleSpec.fallback} — Sent consults the
 * profile, Trash/Drafts match the leaf name), else the conventional name.
 *
 * This is the single home for the precedence that `resolveSentFolder`,
 * `resolveTrashFolder`, and `resolveDraftsFolder` each used to re-encode; the
 * three call sites are now one-line lookups returning the SAME folder they did
 * before. The SQL `draftFolderPaths` (drafts.ts) intentionally remains a separate
 * encoding — it queries the mirrored folder table, not a live LIST, so it is not
 * byte-equivalent to this in-memory predicate.
 */
export function resolveSpecialUseFolder(
  mailboxes: Array<{ path: string; specialUse?: string | null; delimiter?: string | null }>,
  role: SpecialUseRole,
  profile: ProviderProfile
): string {
  const spec = SPECIAL_USE_ROLES[role];
  const bySpecialUse = mailboxes.find((m) => (m.specialUse ?? "").toLowerCase() === spec.specialUse);
  if (bySpecialUse) return bySpecialUse.path;
  return spec.fallback(mailboxes, profile) ?? spec.conventional;
}
