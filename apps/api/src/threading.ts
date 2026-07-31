import { createHash } from "node:crypto";

/**
 * Pure, account-scoped email conversation threading.
 *
 * This module deliberately keeps three identities separate:
 *
 * 1. a physical IMAP row (`id`, folder, UIDVALIDITY, UID),
 * 2. one delivered email, which can have several physical copies, and
 * 3. a conversation assembled from RFC reply headers and conservative hints.
 *
 * It has no database or provider client dependency. The same function can be
 * used by incremental processing and deterministic backfills.
 */

export const THREADING_ALGORITHM_VERSION = 3 as const;

type HeaderValue = string | readonly string[] | null | undefined;

export interface ThreadingMessageInput {
  /** Stable physical mirror-row id. */
  id: string;
  account_id: string;
  folder_path?: string | null;
  uidvalidity?: string | number | bigint | null;
  uid?: string | number | bigint | null;

  /** Raw RFC fields. Values may be folded; repeated fields may be arrays. */
  rfc_message_id?: HeaderValue;
  references_header?: HeaderValue;
  in_reply_to?: HeaderValue;
  headers_json?: Readonly<Record<string, unknown>> | null;

  /**
   * A provider's stable identity for one delivered message (for example,
   * Gmail X-GM-MSGID). This is not a provider conversation id.
   */
  provider_message_id?: string | null;
  provider_message_namespace?: string | null;

  /** A provider conversation hint (for example, Gmail X-GM-THRID). */
  provider_thread_id?: string | null;
  provider_thread_namespace?: string | null;

  internal_date?: Date | string | number | null;
  size_bytes?: string | number | bigint | null;
  /** Strong copy evidence supplied by the caller, ideally a raw-MIME hash. */
  delivery_fingerprint?: string | null;
  raw_mime_hash?: string | null;
  /** Transport-invariant authored MIME evidence, computed only for collisions. */
  authored_delivery_fingerprint?: string | null;
  /** True when the stored MIME evidence can produce a missing authored digest. */
  authored_delivery_repair_eligible?: boolean;
  subject?: string | null;
  from_email?: string | null;
  to_emails?: readonly string[] | null;
  cc_emails?: readonly string[] | null;
  bcc_emails?: readonly string[] | null;

  /** Optional normalized copies of automation/list headers. */
  auto_submitted?: string | null;
  precedence?: string | null;
  list_id?: string | null;
  list_unsubscribe?: string | null;
  x_auto_response_suppress?: string | null;
}

export type ThreadingMethod =
  | "references"
  | "in_reply_to"
  | "provider_thread"
  | "subject_fallback"
  | "standalone";

export type ThreadingConfidence = "high" | "medium" | "low";

export interface ThreadingEvidence {
  header_source: "references" | "in_reply_to" | null;
  provider_thread_key: string | null;
  subject_fallback_keys: string[];
  collapsed_physical_ids: string[];
  parse_warnings: string[];
}

export interface ThreadingAssignment {
  physical_message_id: string;
  account_id: string;
  delivery_key: string;
  conversation_id: string;
  /** The deterministic component anchor used to derive conversation_id. */
  conversation_anchor: string;
  /** Canonical Message-ID token without angle brackets, or null. */
  root_reference: string | null;
  /** Canonical immediate-parent token without angle brackets, or null. */
  parent_reference: string | null;
  /** Present when parent_reference resolves to exactly one delivered email. */
  parent_delivery_key: string | null;
  /** The selected References chain, or the first valid In-Reply-To id. */
  reference_ids: string[];
  strict_message_id: string | null;
  subject_base: string | null;
  provider_thread_key: string | null;
  method: ThreadingMethod;
  /** Coarse, explainable confidence tier; never a fabricated probability. */
  confidence: ThreadingConfidence;
  /** True for missing/ambiguous parents and conservative subject fallback. */
  provisional: boolean;
  evidence: ThreadingEvidence;
  /** Hash of normalized input plus the resulting assignment. */
  input_hash: string;
  /** Version of the executor that produced this assignment. */
  algorithm_version: number;
}

export interface ThreadingOptions {
  /**
   * Disable when the caller has loaded only a partial candidate universe.
   * RFC and provider grouping remain complete; only the weak Re: fallback is
   * skipped. Full-account rebuilds may use the default (`true`).
   */
  allowSubjectFallback?: boolean;
}

interface ParsedSubject {
  base: string | null;
  isReply: boolean;
  isForward: boolean;
}

interface ParsedPhysicalMessage {
  input: ThreadingMessageInput;
  stableKey: string;
  messageId: string | null;
  referenceIds: string[];
  referenceSource: "references" | "in_reply_to" | null;
  providerMessageKey: string | null;
  providerThreadKey: string | null;
  copyFingerprint: string | null;
  copyFingerprints: string[];
  metadataFingerprint: string | null;
  timestamp: number | null;
  subject: ParsedSubject;
  rawSubject: string | null;
  fromEmail: string | null;
  recipients: Set<string>;
  automated: boolean;
  weakSubjectBlocked: boolean;
  warnings: string[];
}

interface Delivery {
  key: string;
  accountId: string;
  physicals: ParsedPhysicalMessage[];
  messageId: string | null;
  referenceIds: string[];
  referenceSource: "references" | "in_reply_to" | null;
  providerThreadKey: string | null;
  timestamp: number | null;
  subject: ParsedSubject;
  rawSubject: string | null;
  fromEmail: string | null;
  recipients: Set<string>;
  automated: boolean;
  weakSubjectBlocked: boolean;
  warnings: string[];
  normalizedInputHash: string;
  nodeKey: string;
}

interface GraphNode {
  key: string;
  reference: string | null;
  deliveryKey: string | null;
  placeholder: boolean;
  ambiguous: boolean;
  parent: GraphNode | null;
  children: Set<GraphNode>;
}

const DOT_ATOM_TEXT = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/;
const DOMAIN_LITERAL = /^\[(?:\\[\x00-\x7f]|[^\[\]\\\r\n])+\]$/;
const MAX_REFERENCE_IDS = 256;
const MAX_MESSAGE_ID_CHARS = 998;
const MAX_MESSAGE_ID_HEADER_CHARS = 256 * 1024;
const MAX_INLINE_PROVIDER_ID_BYTES = 64;
const MAX_PROVIDER_NAMESPACE_BYTES = 16;
const MAX_SUBJECT_BASE_BYTES = 512;
const SUBJECT_FALLBACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function textValue(value: string | number | bigint | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Runtime-locale-independent ordering for versioned deterministic output. */
function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(null);
  if (typeof value === "bigint") return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => binaryCompare(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function valuesOf(value: HeaderValue): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function headerValues(input: ThreadingMessageInput, name: string): string[] {
  const headers = input.headers_json;
  if (!headers) return [];
  const lowerName = name.toLowerCase();
  const values: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) continue;
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") values.push(item);
    }
  }
  return values;
}

function firstHeaderValue(input: ThreadingMessageInput, explicit: string | null | undefined, name: string): string | null {
  const direct = explicit?.trim();
  if (direct) return direct;
  return headerValues(input, name).map((value) => value.trim()).find(Boolean) ?? null;
}

function unfold(value: string): string {
  return value.replace(/\r?\n[ \t]+/g, " ");
}

/** Reject CFWS inside a msg-id payload while retaining quoted/literal data. */
function rejectInternalCfws(value: string): string | null {
  let result = "";
  let quoted = false;
  let domainLiteral = false;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      result += char;
      escaped = true;
      continue;
    }
    if (!domainLiteral && char === '"') {
      quoted = !quoted;
      result += char;
      continue;
    }
    if (!quoted && char === "[") {
      if (domainLiteral) return null;
      domainLiteral = true;
      result += char;
      continue;
    }
    if (!quoted && char === "]") {
      if (!domainLiteral) return null;
      domainLiteral = false;
      result += char;
      continue;
    }
    // RFC 5322 permits CFWS around the angle-bracketed msg-id, not inside
    // id-left / id-right. Deleting it here can turn malformed input such as
    // `root @ example` into the valid id `root@example`, creating a false edge.
    if (!quoted && !domainLiteral && (char === "(" || char === ")" || /\s/.test(char))) return null;
    result += char;
  }

  return quoted || domainLiteral || escaped ? null : result;
}

/**
 * Canonicalize one bracket payload. Case is intentionally preserved: RFC 5256
 * requires Message-ID comparisons to be case-sensitive. Syntax-equivalent
 * quoted dot-atoms are unquoted (`<"x"@y>` and `<x@y>` compare equal).
 */
export function canonicalizeMessageId(payload: string): string | null {
  if (payload.length > MAX_MESSAGE_ID_CHARS) return null;
  const compact = rejectInternalCfws(unfold(payload));
  if (!compact || compact.length > MAX_MESSAGE_ID_CHARS || /[\r\n]/.test(compact)) return null;

  let quoted = false;
  let domainLiteral = false;
  let escaped = false;
  let separator = -1;
  for (let index = 0; index < compact.length; index += 1) {
    const char = compact[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && (quoted || domainLiteral)) {
      escaped = true;
      continue;
    }
    if (!domainLiteral && char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === "[") {
      if (domainLiteral) return null;
      domainLiteral = true;
      continue;
    }
    if (!quoted && char === "]") {
      if (!domainLiteral) return null;
      domainLiteral = false;
      continue;
    }
    if ((char === "<" || char === ">") && !quoted && !domainLiteral) return null;
    if (char === "@" && !quoted && !domainLiteral) {
      if (separator !== -1) return null;
      separator = index;
    }
  }
  if (quoted || domainLiteral || escaped || separator <= 0 || separator === compact.length - 1) return null;

  let local = compact.slice(0, separator);
  const domain = compact.slice(separator + 1);

  if (local.startsWith('"') && local.endsWith('"') && local.length >= 2) {
    const unquoted = local.slice(1, -1).replace(/\\(.)/g, "$1");
    if (DOT_ATOM_TEXT.test(unquoted)) local = unquoted;
    else if (/\r|\n/.test(unquoted)) return null;
  } else if (!DOT_ATOM_TEXT.test(local)) {
    return null;
  }

  if (!DOT_ATOM_TEXT.test(domain) && !DOMAIN_LITERAL.test(domain)) return null;
  return `${local}@${domain}`;
}

interface MessageIdScanResult {
  tokens: string[];
  oversized: boolean;
  truncated: boolean;
}

interface ReconciledHeaderScan extends MessageIdScanResult {
  conflict: boolean;
  hadValue: boolean;
  malformed: boolean;
}

/** Single-pass, resource-bounded extraction from untrusted header text. */
function scanMessageIdTokens(
  value: HeaderValue,
  keep: "first" | "last",
  limit: number
): MessageIdScanResult {
  const rawValues = valuesOf(value);
  let totalChars = 0;
  for (const rawValue of rawValues) {
    totalChars += rawValue.length;
    if (totalChars > MAX_MESSAGE_ID_HEADER_CHARS) {
      return { tokens: [], oversized: true, truncated: true };
    }
  }

  const allTokens: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of rawValues) {
    const text = unfold(rawValue);
    let start = -1;
    let quoted = false;
    let domainLiteral = false;
    let escaped = false;
    let commentDepth = 0;
    let outerCommentDepth = 0;
    let outerQuoted = false;
    let outerEscaped = false;

    const reset = (nextStart: number): void => {
      start = nextStart;
      quoted = false;
      domainLiteral = false;
      escaped = false;
      commentDepth = 0;
    };

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (start === -1) {
        if (outerEscaped) {
          outerEscaped = false;
          continue;
        }
        if (outerCommentDepth > 0) {
          if (char === "\\") outerEscaped = true;
          else if (char === "(") outerCommentDepth += 1;
          else if (char === ")") outerCommentDepth -= 1;
          continue;
        }
        if (outerQuoted) {
          if (char === "\\") outerEscaped = true;
          else if (char === '"') outerQuoted = false;
          continue;
        }
        if (char === "(") {
          outerCommentDepth = 1;
          continue;
        }
        if (char === '"') {
          outerQuoted = true;
          continue;
        }
        if (char === "<") reset(index);
        continue;
      }
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\" && (quoted || domainLiteral || commentDepth > 0)) {
        escaped = true;
        continue;
      }
      if (commentDepth > 0) {
        if (char === "(") commentDepth += 1;
        else if (char === ")") commentDepth -= 1;
        continue;
      }
      if (!quoted && !domainLiteral && char === "<") {
        // A malformed outer fragment cannot own a nested token. Restarting at
        // the inner opener recovers it without rescanning the suffix.
        reset(index);
        continue;
      }
      if (!quoted && !domainLiteral && char === "(") {
        commentDepth = 1;
        continue;
      }
      if (!domainLiteral && char === '"') {
        quoted = !quoted;
        continue;
      }
      if (!quoted && char === "[") {
        domainLiteral = true;
        continue;
      }
      if (!quoted && domainLiteral && char === "]") {
        domainLiteral = false;
        continue;
      }
      if (char !== ">" || quoted || domainLiteral) continue;

      const token = canonicalizeMessageId(text.slice(start + 1, index));
      if (token && !seen.has(token)) {
        seen.add(token);
        allTokens.push(token);
      }
      reset(-1);
    }
  }

  const truncated = allTokens.length > limit;
  return {
    tokens: keep === "first" ? allTokens.slice(0, limit) : allTokens.slice(-limit),
    oversized: false,
    truncated
  };
}

/**
 * Extract valid, angle-bracketed msg-id tokens from arbitrary folded header
 * text. Adjacent tokens are accepted. Unbalanced/malformed fragments are
 * ignored rather than guessed from bare email-address-looking text.
 */
export function extractMessageIdTokens(value: HeaderValue): string[] {
  return scanMessageIdTokens(value, "first", MAX_REFERENCE_IDS).tokens;
}

function reconcileHeaderOccurrences(
  values: string[],
  keep: "first" | "last",
  limit: number,
  compatible: (left: readonly string[], right: readonly string[]) => boolean
): ReconciledHeaderScan {
  const present = values.filter((value) => value.trim());
  let totalChars = 0;
  for (const value of present) {
    totalChars += value.length;
    if (totalChars > MAX_MESSAGE_ID_HEADER_CHARS) {
      return {
        tokens: [],
        oversized: true,
        truncated: true,
        conflict: false,
        hadValue: true,
        malformed: false
      };
    }
  }
  if (present.length === 0) {
    return {
      tokens: [],
      oversized: false,
      truncated: false,
      conflict: false,
      hadValue: false,
      malformed: false
    };
  }

  let selected: string[] | null = null;
  let oversized = false;
  let truncated = false;
  let malformed = false;
  let conflict = false;
  for (const value of present) {
    const scan = scanMessageIdTokens(value, keep, limit);
    oversized ||= scan.oversized;
    truncated ||= scan.truncated;
    if (scan.tokens.length === 0 && !scan.oversized) {
      malformed = true;
      continue;
    }
    if (!selected) {
      selected = scan.tokens;
      continue;
    }
    if (!compatible(selected, scan.tokens)) {
      conflict = true;
      continue;
    }
    if (scan.tokens.length > selected.length) selected = scan.tokens;
  }

  return {
    tokens: oversized || malformed || conflict ? [] : selected ?? [],
    oversized,
    truncated,
    conflict,
    hadValue: true,
    malformed
  };
}

function reconcileHeaderTokenSources(
  input: ThreadingMessageInput,
  explicit: HeaderValue,
  name: string,
  keep: "first" | "last",
  limit: number,
  compatible: (left: readonly string[], right: readonly string[]) => boolean = compatibleReferenceChains
): ReconciledHeaderScan {
  const explicitValues = valuesOf(explicit);
  const jsonValues = headerValues(input, name);
  const explicitScan = reconcileHeaderOccurrences(explicitValues, keep, limit, compatible);
  const jsonScan = reconcileHeaderOccurrences(jsonValues, keep, limit, compatible);
  const explicitHadValue = explicitScan.hadValue;
  const jsonHadValue = jsonScan.hadValue;
  const malformed = explicitScan.malformed || jsonScan.malformed;

  if (explicitHadValue && jsonHadValue) {
    const conflict = explicitScan.conflict || jsonScan.conflict ||
      explicitScan.oversized || jsonScan.oversized || malformed ||
      !compatible(explicitScan.tokens, jsonScan.tokens);
    if (conflict) {
      return {
        tokens: [],
        oversized: explicitScan.oversized || jsonScan.oversized,
        truncated: explicitScan.truncated || jsonScan.truncated,
        conflict: true,
        hadValue: true,
        malformed
      };
    }

    const tokens = explicitScan.tokens.length >= jsonScan.tokens.length
      ? explicitScan.tokens
      : jsonScan.tokens;
    return {
      tokens,
      oversized: false,
      truncated: explicitScan.truncated || jsonScan.truncated,
      conflict: false,
      hadValue: true,
      malformed: false
    };
  }

  const selected = explicitHadValue ? explicitScan : jsonScan;
  return {
    ...selected,
    hadValue: explicitHadValue || jsonHadValue,
    malformed
  };
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  const separator = normalized.lastIndexOf("@");
  if (separator <= 0 || separator === normalized.length - 1) return normalized;
  // RFC mailbox local-parts are technically case-sensitive. Weak subject
  // evidence must not merge two distinct mailboxes merely because most large
  // providers happen to case-fold them; only the DNS domain is normalized.
  return `${normalized.slice(0, separator)}@${normalized.slice(separator + 1).toLowerCase()}`;
}

function parseTimestamp(value: Date | string | number | null | undefined): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

function parseSubject(value: string | null | undefined, policyVersion: 1 | 2 | 3): ParsedSubject {
  let subject = value?.normalize("NFKC").replace(/\s+/g, " ").trim() ?? "";
  if (!subject) return { base: null, isReply: false, isForward: false };

  const boundedBase = (candidate: string): string | null =>
    Buffer.byteLength(candidate, "utf8") <= MAX_SUBJECT_BASE_BYTES ? candidate : null;

  const forwardPrefix = policyVersion >= 3
    ? /^(?:\[[^\]]{1,80}\]\s*)?(?:fw|fwd|wg|tr|rv|enc|转发|轉寄|転送)\s*:/i
    : /^(?:\[[^\]]{1,80}\]\s*)?(?:fw|fwd)\s*:/i;
  const directForward = forwardPrefix.test(subject) ||
    /^\[fwd:/i.test(subject) || /\(fwd\)\s*$/i.test(subject);
  if (directForward) {
    return { base: boundedBase(subject.toLocaleLowerCase("en-US")), isReply: false, isForward: true };
  }

  let isReply = false;
  for (;;) {
    const match = subject.match(/^(?:\[[^\]]{1,80}\]\s*)?re(?:\[\d+\])?\s*:\s*/i);
    if (!match) break;
    isReply = true;
    subject = subject.slice(match[0].length).trim();
  }

  const forwardedAfterReply = forwardPrefix.test(subject) ||
    /^\[fwd:/i.test(subject) || /\(fwd\)\s*$/i.test(subject);
  const normalizedBase = subject ? subject.toLocaleLowerCase("en-US") : null;
  if (policyVersion <= 2) {
    return {
      base: normalizedBase ? boundedBase(normalizedBase) : null,
      isReply: isReply && !forwardedAfterReply,
      isForward: forwardedAfterReply
    };
  }
  return {
    base: normalizedBase ? boundedBase(normalizedBase) : null,
    // "Re: Fwd: ..." is a reply to a new forwarded outer message, not a
    // second forward action. Keeping it reply-shaped lets that new branch form
    // its own conversation while the direct "Fwd:" root remains isolated.
    isReply,
    isForward: forwardedAfterReply && !isReply
  };
}

function isAutomated(input: ThreadingMessageInput): boolean {
  const autoSubmitted = firstHeaderValue(input, input.auto_submitted, "auto-submitted")?.toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;

  const precedence = firstHeaderValue(input, input.precedence, "precedence")?.toLowerCase();
  if (precedence && /(?:^|\s|,)(?:bulk|list|junk)(?:$|\s|,)/.test(precedence)) return true;

  return Boolean(
    firstHeaderValue(input, input.list_id, "list-id") ||
    firstHeaderValue(input, input.list_unsubscribe, "list-unsubscribe") ||
    firstHeaderValue(input, input.x_auto_response_suppress, "x-auto-response-suppress")
  );
}

function physicalStableKey(input: ThreadingMessageInput): string {
  return [
    input.account_id,
    input.id,
    input.folder_path ?? "",
    textValue(input.uidvalidity),
    textValue(input.uid)
  ].join("\u0000");
}

function providerKey(namespace: string | null | undefined, id: string | null | undefined, fallback: string): string | null {
  const normalizedId = id?.trim();
  if (!normalizedId) return null;
  const rawNamespace = namespace?.trim() || fallback;
  const normalizedNamespace = Buffer.byteLength(rawNamespace, "utf8") <= MAX_PROVIDER_NAMESPACE_BYTES &&
    /^[A-Za-z0-9._-]+$/.test(rawNamespace)
    ? rawNamespace
    : `ns-${sha256(rawNamespace).slice(0, 16)}`;
  const normalizedOpaqueId = Buffer.byteLength(normalizedId, "utf8") <= MAX_INLINE_PROVIDER_ID_BYTES
    ? normalizedId
    : `sha256:${sha256(normalizedId)}`;
  return `${normalizedNamespace}:${normalizedOpaqueId}`;
}

function physicalCopyFingerprint(input: ThreadingMessageInput): string | null {
  const rawMimeHash = input.raw_mime_hash?.trim();
  if (rawMimeHash) return `raw:${rawMimeHash}`;
  const explicit = input.delivery_fingerprint?.trim();
  return explicit ? `parsed:${explicit}` : null;
}

function physicalCopyFingerprints(input: ThreadingMessageInput): string[] {
  const fingerprints: string[] = [];
  const legacy = physicalCopyFingerprint(input);
  if (legacy) fingerprints.push(legacy);
  const parsed = input.delivery_fingerprint?.trim();
  if (parsed && legacy !== `parsed:${parsed}`) fingerprints.push(`parsed:${parsed}`);
  const authored = input.authored_delivery_fingerprint?.trim();
  if (authored) fingerprints.push(`authored:${authored}`);
  return [...new Set(fingerprints)];
}

function canonicalNonnegativeInteger(value: string | number | bigint | null | undefined): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  try {
    const integer = BigInt(value);
    return integer >= 0n ? integer.toString() : null;
  } catch {
    return null;
  }
}

function normalizedMailboxList(values: readonly string[] | null | undefined): string[] {
  return (values ?? [])
    .map(normalizeEmail)
    .filter((value): value is string => Boolean(value))
    .sort(binaryCompare);
}

function exactMetadataFingerprint(
  input: ThreadingMessageInput,
  messageId: string | null,
  timestamp: number | null,
  fromEmail: string | null
): string | null {
  const sizeBytes = canonicalNonnegativeInteger(input.size_bytes);
  const subject = input.subject?.normalize("NFKC").replace(/\s+/g, " ").trim() ?? "";
  const to = normalizedMailboxList(input.to_emails);
  const cc = normalizedMailboxList(input.cc_emails);
  const bcc = normalizedMailboxList(input.bcc_emails);
  if (!messageId || timestamp === null || sizeBytes === null || !subject || !fromEmail ||
      to.length + cc.length + bcc.length === 0) return null;
  return `metadata:${sha256(stableStringify({
    account_id: input.account_id,
    message_id: messageId,
    internal_date_ms: timestamp,
    size_bytes: sizeBytes,
    subject,
    from_email: fromEmail,
    to_emails: to,
    cc_emails: cc,
    bcc_emails: bcc
  }))}`;
}

function parsePhysicalMessage(input: ThreadingMessageInput, policyVersion: 1 | 2 | 3): ParsedPhysicalMessage {
  const warnings = new Set<string>();
  const messageIdScan = reconcileHeaderTokenSources(
    input,
    input.rfc_message_id,
    "message-id",
    "first",
    2,
    (left, right) => left.length === right.length && left.every((token, index) => token === right[index])
  );
  const messageIds = messageIdScan.tokens;
  const messageId = messageIds[0] ?? null;
  if (messageIdScan.oversized) warnings.add("oversized_message_id_ignored");
  else if (messageIdScan.conflict) warnings.add("conflicting_message_id_sources_ignored");
  else if (messageIdScan.hadValue && !messageId) warnings.add("malformed_message_id_ignored");
  if (messageIds.length > 1 || messageIdScan.truncated) warnings.add("multiple_message_ids_first_used");

  const referencesScan = reconcileHeaderTokenSources(
    input,
    input.references_header,
    "references",
    "last",
    MAX_REFERENCE_IDS
  );
  const references = referencesScan.tokens;
  if (referencesScan.oversized) warnings.add("oversized_references_ignored");
  else if (referencesScan.malformed) {
    warnings.add("malformed_references_ignored");
  }
  if (referencesScan.conflict) warnings.add("conflicting_references_sources_ignored");
  if (referencesScan.truncated && !referencesScan.oversized) warnings.add("references_truncated");

  const inReplyToScan = reconcileHeaderTokenSources(
    input,
    input.in_reply_to,
    "in-reply-to",
    "first",
    2
  );
  const inReplyTo = inReplyToScan.tokens;
  if (inReplyToScan.oversized) warnings.add("oversized_in_reply_to_ignored");
  else if (inReplyToScan.malformed) {
    warnings.add("malformed_in_reply_to_ignored");
  }
  if (inReplyToScan.conflict) warnings.add("conflicting_in_reply_to_sources_ignored");
  if (inReplyTo.length > 1 || inReplyToScan.truncated) warnings.add("multiple_in_reply_to_first_used");
  const malformedReplyHeaders = messageIdScan.oversized || messageIdScan.conflict ||
    referencesScan.oversized || referencesScan.conflict || inReplyToScan.oversized ||
    (referencesScan.hadValue && references.length === 0) ||
    inReplyToScan.conflict ||
    (inReplyToScan.hadValue && inReplyTo.length === 0);

  let referenceSource: "references" | "in_reply_to" | null = null;
  let referenceIds: string[] = [];
  if (references.length > 0) {
    referenceSource = "references";
    // The tail contains the immediate parent. On pathological headers prefer a
    // conservative false split over inventing an edge across an omitted gap.
    referenceIds = references;
    if (inReplyTo[0] && inReplyTo[0] !== referenceIds.at(-1)) {
      warnings.add("conflicting_in_reply_to_ignored");
    }
  } else if (inReplyTo[0]) {
    referenceSource = "in_reply_to";
    referenceIds = [inReplyTo[0]];
  }

  if (messageId && referenceIds.includes(messageId)) {
    warnings.add("self_reference_ignored");
    referenceIds = referenceIds.filter((token) => token !== messageId);
  }

  const recipients = new Set<string>();
  for (const address of [...(input.to_emails ?? []), ...(input.cc_emails ?? []), ...(input.bcc_emails ?? [])]) {
    const normalized = normalizeEmail(address);
    if (normalized) recipients.add(normalized);
  }

  const timestamp = parseTimestamp(input.internal_date);
  const parsedSubject = parseSubject(input.subject, policyVersion);
  const fromEmail = normalizeEmail(input.from_email);
  if (policyVersion >= 3 && parsedSubject.isForward && referenceIds.length > 0) {
    warnings.add("forward_reply_headers_not_conversation_edge");
    referenceIds = [];
    referenceSource = null;
  }

  return {
    input,
    stableKey: physicalStableKey(input),
    messageId,
    referenceIds,
    referenceSource,
    providerMessageKey: providerKey(
      input.provider_message_namespace,
      input.provider_message_id,
      "provider-message"
    ),
    providerThreadKey: providerKey(
      input.provider_thread_namespace ?? input.provider_message_namespace,
      input.provider_thread_id,
      "provider-thread"
    ),
    copyFingerprint: physicalCopyFingerprint(input),
    copyFingerprints: physicalCopyFingerprints(input),
    metadataFingerprint: policyVersion >= 3
      ? exactMetadataFingerprint(input, messageId, timestamp, fromEmail)
      : null,
    timestamp,
    subject: parsedSubject,
    rawSubject: input.subject?.trim() || null,
    fromEmail,
    recipients,
    automated: isAutomated(input),
    weakSubjectBlocked: malformedReplyHeaders,
    warnings: [...warnings].sort()
  };
}

/** Fixed-size evidence tokens used to close a bounded repository rebuild. */
export function deliveryClosureFingerprints(
  input: ThreadingMessageInput,
  algorithmVersion: number = THREADING_ALGORITHM_VERSION
): string[] {
  if (algorithmVersion <= 1) {
    const legacy = physicalCopyFingerprint(input);
    return legacy ? [legacy] : [];
  }
  const parsed = parsePhysicalMessage(input, algorithmVersion >= 3 ? 3 : 2);
  return parsed.metadataFingerprint
    ? [...parsed.copyFingerprints, parsed.metadataFingerprint]
    : [...parsed.copyFingerprints];
}

function baseDeliveryKey(message: ParsedPhysicalMessage): string {
  if (message.providerMessageKey) {
    return `delivery:provider:${sha256(`${message.input.account_id}\u0000${message.providerMessageKey}`)}`;
  }
  if (message.messageId) {
    return `delivery:message-id:${sha256(`${message.input.account_id}\u0000${message.messageId}`)}`;
  }
  if (message.copyFingerprint) {
    return `delivery:fingerprint:${sha256(`${message.input.account_id}\u0000${message.copyFingerprint}`)}`;
  }
  const rowIdentity = [
    message.input.account_id,
    message.input.folder_path ?? "",
    textValue(message.input.uidvalidity),
    textValue(message.input.uid),
    message.input.id
  ].join("\u0000");
  return `delivery:row:${sha256(rowIdentity)}`;
}

function physicalQuality(message: ParsedPhysicalMessage): number {
  const sourceScore = message.referenceSource === "references" ? 2_000 : message.referenceSource === "in_reply_to" ? 1_000 : 0;
  return sourceScore + message.referenceIds.length * 10 + (message.messageId ? 1 : 0);
}

function isChainSuffix(shorter: readonly string[], longer: readonly string[]): boolean {
  if (shorter.length > longer.length) return false;
  const offset = longer.length - shorter.length;
  return shorter.every((token, index) => token === longer[offset + index]);
}

function compatibleReferenceChains(left: readonly string[], right: readonly string[]): boolean {
  return isChainSuffix(left, right) || isChainSuffix(right, left);
}

function buildLegacyDeliveryGroups(messages: ParsedPhysicalMessage[]): Map<string, ParsedPhysicalMessage[]> {
  const baseGroups = new Map<string, ParsedPhysicalMessage[]>();
  for (const message of messages) {
    const key = baseDeliveryKey(message);
    const group = baseGroups.get(key) ?? [];
    group.push(message);
    baseGroups.set(key, group);
  }

  // Provider message identities collapse directly. A complete exact
  // fingerprint also identifies copies when no valid Message-ID survives
  // parsing. A strict Message-ID is only a copy candidate: when more than one
  // physical row carries it, require an exact parsed or raw-MIME fingerprint.
  // Otherwise suffix each delivery with a deterministic variant key. This
  // prevents broken senders that reuse Message-ID from silently losing mail.
  const groups = new Map<string, ParsedPhysicalMessage[]>();
  for (const [baseKey, baseMessages] of baseGroups) {
    const providerBacked = baseMessages.every((message) => message.providerMessageKey !== null);
    const messageIdBacked = !providerBacked && baseMessages.some((message) => message.messageId !== null);
    if (!messageIdBacked || baseMessages.length === 1) {
      groups.set(baseKey, baseMessages);
      continue;
    }

    const variants = new Map<string, ParsedPhysicalMessage[]>();
    for (const message of baseMessages) {
      const variant = message.copyFingerprint
        ? `fingerprint:${message.copyFingerprint}`
        : `physical:${message.stableKey}`;
      const group = variants.get(variant) ?? [];
      group.push(message);
      variants.set(variant, group);
    }
    if (variants.size === 1) {
      groups.set(baseKey, baseMessages);
      continue;
    }
    for (const [variant, variantMessages] of variants) {
      groups.set(`delivery:variant:${sha256(`${baseKey}\u0000${variant}`)}`, variantMessages);
    }
  }

  return groups;
}

function sharedFingerprintComponents(messages: ParsedPhysicalMessage[]): ParsedPhysicalMessage[][] {
  const ordered = [...messages].sort((left, right) => binaryCompare(left.stableKey, right.stableKey));
  const parents = ordered.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) parents[rightRoot] = leftRoot;
    else parents[leftRoot] = rightRoot;
  };
  const fingerprintOwner = new Map<string, number>();
  ordered.forEach((message, index) => {
    for (const fingerprint of message.copyFingerprints) {
      const owner = fingerprintOwner.get(fingerprint);
      if (owner === undefined) fingerprintOwner.set(fingerprint, index);
      else union(index, owner);
    }
  });

  const components = new Map<number, ParsedPhysicalMessage[]>();
  ordered.forEach((message, index) => {
    const root = find(index);
    const component = components.get(root) ?? [];
    component.push(message);
    components.set(root, component);
  });
  return [...components.values()].sort((left, right) => binaryCompare(left[0].stableKey, right[0].stableKey));
}

function authoredFingerprint(message: ParsedPhysicalMessage): string | null {
  return message.copyFingerprints.find((fingerprint) => fingerprint.startsWith("authored:")) ?? null;
}

function conflictAwareDeliveryComponents(messages: ParsedPhysicalMessage[]): ParsedPhysicalMessage[][] {
  const ordered = [...messages].sort((left, right) => binaryCompare(left.stableKey, right.stableKey));
  const parents = ordered.map((_, index) => index);
  const componentSizes = ordered.map(() => 1);
  const authored = ordered.map((message) => {
    const value = authoredFingerprint(message);
    return value ? new Set([value]) : new Set<string>();
  });
  const folders = ordered.map((message) => {
    const value = message.input.folder_path?.trim();
    return value ? new Set([value]) : new Set<string>();
  });
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): boolean => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return true;
    const combinedAuthored = new Set([...authored[leftRoot], ...authored[rightRoot]]);
    if (combinedAuthored.size > 1) return false;
    const root = componentSizes[leftRoot] > componentSizes[rightRoot]
      ? leftRoot
      : componentSizes[rightRoot] > componentSizes[leftRoot]
        ? rightRoot
        : Math.min(leftRoot, rightRoot);
    const child = root === leftRoot ? rightRoot : leftRoot;
    parents[child] = root;
    componentSizes[root] += componentSizes[child];
    authored[root] = combinedAuthored;
    for (const folder of folders[child]) folders[root].add(folder);
    return true;
  };

  const fingerprintGroups = new Map<string, number[]>();
  ordered.forEach((message, index) => {
    for (const fingerprint of message.copyFingerprints) {
      const group = fingerprintGroups.get(fingerprint) ?? [];
      group.push(index);
      fingerprintGroups.set(fingerprint, group);
    }
  });

  // First join identical body evidence only within the same authored digest
  // (or while every row lacks one). A missing authored digest may attach later,
  // but it must never bridge two contradictory complete authored digests.
  for (const indices of fingerprintGroups.values()) {
    const buckets = new Map<string, number[]>();
    for (const index of indices) {
      const key = authoredFingerprint(ordered[index]) ?? "";
      const bucket = buckets.get(key) ?? [];
      bucket.push(index);
      buckets.set(key, bucket);
    }
    for (const bucket of buckets.values()) {
      for (let index = 1; index < bucket.length; index += 1) union(bucket[0], bucket[index]);
    }
  }

  const authoredNeighbors = new Map<number, Map<string, number>>();
  for (const indices of fingerprintGroups.values()) {
    const roots = [...new Set(indices.map(find))];
    const authoredRoots = new Map<string, number>();
    for (const root of roots) {
      const value = [...authored[root]][0];
      if (value && !authoredRoots.has(value)) authoredRoots.set(value, root);
    }
    for (const root of roots.filter((candidate) => authored[candidate].size === 0)) {
      const neighbors = authoredNeighbors.get(root) ?? new Map<string, number>();
      // One witness proves compatibility; two distinct authored values prove a
      // conflict. Retaining any more would turn a hostile collision family
      // into quadratic memory and work without changing the decision.
      for (const [value, authoredRoot] of authoredRoots) {
        if (!neighbors.has(value)) neighbors.set(value, authoredRoot);
        if (neighbors.size >= 2) break;
      }
      authoredNeighbors.set(root, neighbors);
    }
  }
  const authoredConflictRoots = new Set<number>();
  for (const [unresolvedRoot, neighborRoots] of authoredNeighbors) {
    const root = find(unresolvedRoot);
    if (authored[root].size > 0) continue;
    const neighbors = [...new Set([...neighborRoots.values()].map(find))]
      .filter((neighbor) => authored[neighbor].size === 1)
      .sort((left, right) => left - right);
    const authoredValues = new Set(neighbors.flatMap((neighbor) => [...authored[neighbor]]));
    if (authoredValues.size === 1 && neighbors.length > 0) union(root, neighbors[0]);
    else if (authoredValues.size > 1) authoredConflictRoots.add(root);
  }
  for (let index = 0; index < ordered.length; index += 1) {
    if (authoredConflictRoots.has(find(index))) {
      ordered[index].warnings.push("delivery_authored_fingerprint_conflict");
    }
  }

  const metadataGroups = new Map<string, number[]>();
  ordered.forEach((message, index) => {
    if (!message.metadataFingerprint) return;
    const group = metadataGroups.get(message.metadataFingerprint) ?? [];
    group.push(index);
    metadataGroups.set(message.metadataFingerprint, group);
  });
  for (const indices of metadataGroups.values()) {
    const roots = [...new Set(indices.map(find))];
    const authoredValues = new Set(roots.flatMap((root) => [...authored[find(root)]]));
    const inheritedAuthoredConflict = roots.some((root) => authoredConflictRoots.has(find(root)));
    const foldersSeen = new Set<string>();
    const distinctMailboxCopies = roots.every((root) => {
      const componentFolders = folders[find(root)];
      if (componentFolders.size === 0) return false;
      for (const folder of componentFolders) {
        if (foldersSeen.has(folder)) return false;
        foldersSeen.add(folder);
      }
      return true;
    });
    if (authoredValues.size <= 1 && !inheritedAuthoredConflict && distinctMailboxCopies) {
      if (roots.length > 1) {
        for (const index of indices) {
          ordered[index].warnings.push("delivery_metadata_fingerprint_match");
        }
      }
      for (let index = 1; index < roots.length; index += 1) union(roots[0], roots[index]);
      continue;
    }
    if (!distinctMailboxCopies) {
      for (const index of indices) {
        ordered[index].warnings.push("delivery_metadata_same_folder_ignored");
      }
      continue;
    }
    if (inheritedAuthoredConflict) {
      for (const index of indices) {
        ordered[index].warnings.push("delivery_metadata_collision_authored_conflict");
      }
      continue;
    }
    for (const index of indices) {
      ordered[index].warnings.push("delivery_metadata_collision_authored_conflict");
    }
    const buckets = new Map<string, number[]>();
    for (const root of roots) {
      const resolved = find(root);
      const key = [...authored[resolved]][0] ?? "";
      const bucket = buckets.get(key) ?? [];
      bucket.push(resolved);
      buckets.set(key, bucket);
    }
    for (const bucket of buckets.values()) {
      for (let index = 1; index < bucket.length; index += 1) union(bucket[0], bucket[index]);
    }
  }

  const components = new Map<number, ParsedPhysicalMessage[]>();
  ordered.forEach((message, index) => {
    const root = find(index);
    const component = components.get(root) ?? [];
    component.push(message);
    components.set(root, component);
  });
  return [...components.values()].sort((left, right) => binaryCompare(left[0].stableKey, right[0].stableKey));
}

function componentFingerprintKey(messages: ParsedPhysicalMessage[], useMetadataFallback = false): string {
  const fingerprints = [...new Set(messages.flatMap((message) => message.copyFingerprints))].sort();
  if (useMetadataFallback && messages.length > 1) {
    const commonFingerprints = messages[0].copyFingerprints.filter((fingerprint) =>
      messages.every((message) => message.copyFingerprints.includes(fingerprint))
    );
    const metadata = [...new Set(messages.flatMap((message) =>
      message.metadataFingerprint ? [message.metadataFingerprint] : []
    ))];
    if (commonFingerprints.length === 0 && metadata.length === 1) {
      return `metadata-fingerprint:${metadata[0]}`;
    }
  }
  if (fingerprints.length > 0) return `fingerprints:${fingerprints.join("\u0000")}`;
  return `physical:${messages[0].stableKey}`;
}

function buildSharedEvidenceDeliveryGroups(
  messages: ParsedPhysicalMessage[],
  groupingVersion: 2 | 3
): Map<string, ParsedPhysicalMessage[]> {
  const groups = new Map<string, ParsedPhysicalMessage[]>();
  const providerGroups = new Map<string, ParsedPhysicalMessage[]>();
  const messageIdGroups = new Map<string, ParsedPhysicalMessage[]>();
  const fingerprintOnly: ParsedPhysicalMessage[] = [];

  for (const message of messages) {
    if (message.providerMessageKey) {
      const key = baseDeliveryKey(message);
      const group = providerGroups.get(key) ?? [];
      group.push(message);
      providerGroups.set(key, group);
    } else if (message.messageId) {
      const key = baseDeliveryKey(message);
      const group = messageIdGroups.get(key) ?? [];
      group.push(message);
      messageIdGroups.set(key, group);
    } else if (message.copyFingerprints.length > 0) {
      fingerprintOnly.push(message);
    } else {
      groups.set(baseDeliveryKey(message), [message]);
    }
  }

  for (const [key, group] of providerGroups) groups.set(key, group);
  for (const [baseKey, candidates] of messageIdGroups) {
    const components = groupingVersion >= 3
      ? conflictAwareDeliveryComponents(candidates)
      : sharedFingerprintComponents(candidates);
    if (components.length === 1) {
      groups.set(baseKey, components[0]);
      continue;
    }
    for (const component of components) {
      const variant = componentFingerprintKey(component, groupingVersion >= 3);
      groups.set(`delivery:variant:${sha256(`${baseKey}\u0000${variant}`)}`, component);
    }
  }

  for (const component of sharedFingerprintComponents(fingerprintOnly)) {
    const accountId = component[0].input.account_id;
    const variant = componentFingerprintKey(component);
    groups.set(`delivery:fingerprint:${sha256(`${accountId}\u0000${variant}`)}`, component);
  }
  return groups;
}

function buildDeliveries(
  messages: ParsedPhysicalMessage[],
  groupingVersion: 1 | 2 | 3
): Delivery[] {
  const groups = groupingVersion === 1
    ? buildLegacyDeliveryGroups(messages)
    : buildSharedEvidenceDeliveryGroups(messages, groupingVersion);

  const deliveries: Delivery[] = [];
  for (const [key, unsorted] of groups) {
    const physicals = [...unsorted].sort((left, right) => binaryCompare(left.stableKey, right.stableKey));
    const ranked = [...physicals].sort((left, right) => {
      const quality = physicalQuality(right) - physicalQuality(left);
      return quality || binaryCompare(left.stableKey, right.stableKey);
    });
    const representative = ranked[0];

    const messageIds = [...new Set(physicals.flatMap((message) => message.messageId ? [message.messageId] : []))].sort();
    const providerThreadKeys = [...new Set(
      physicals.flatMap((message) => message.providerThreadKey ? [message.providerThreadKey] : [])
    )].sort();
    const warnings = new Set(physicals.flatMap((message) => message.warnings));
    if (messageIds.length > 1) warnings.add("delivery_copies_disagree_on_message_id");
    if (providerThreadKeys.length > 1) warnings.add("delivery_copies_disagree_on_provider_thread");

    const referenceCandidates = physicals
      .filter((message) => message.referenceIds.length > 0)
      .sort((left, right) =>
        right.referenceIds.length - left.referenceIds.length ||
        physicalQuality(right) - physicalQuality(left) ||
        binaryCompare(left.stableKey, right.stableKey)
      );
    const referenceWinner = referenceCandidates[0];
    const replyHeadersConflict = Boolean(referenceWinner) && referenceCandidates
      .some((candidate) => !compatibleReferenceChains(referenceWinner.referenceIds, candidate.referenceIds));
    if (replyHeadersConflict) warnings.add("delivery_copies_disagree_on_reply_headers");
    const referenceIds = replyHeadersConflict ? [] : [...(referenceWinner?.referenceIds ?? [])];
    const referenceSource = replyHeadersConflict ? null : referenceWinner?.referenceSource ?? null;

    const recipients = new Set<string>();
    for (const message of physicals) for (const address of message.recipients) recipients.add(address);
    const timestampValues = physicals
      .flatMap((message) => message.timestamp === null ? [] : [message.timestamp])
      .sort((left, right) => left - right);
    const subjectMessage = ranked.find((message) => message.subject.base !== null) ?? representative;
    const fromMessage = ranked.find((message) => message.fromEmail !== null) ?? representative;
    const messageId = messageIds.length === 1 ? messageIds[0] : null;
    const selectedReferenceIds = referenceIds.filter((token) => token !== messageId);
    const weakSubjectBlocked = physicals.some((message) => message.weakSubjectBlocked) ||
      replyHeadersConflict || messageIds.length > 1 || providerThreadKeys.length > 1;
    const normalizedInput = {
      account_id: representative.input.account_id,
      delivery_key: key,
      message_id: messageId,
      reference_ids: selectedReferenceIds,
      reference_source: referenceSource,
      provider_thread_key: providerThreadKeys.length === 1 ? providerThreadKeys[0] : null,
      timestamp: timestampValues[0] ?? null,
      subject: subjectMessage.subject,
      from_email: fromMessage.fromEmail,
      recipients: [...recipients].sort(),
      automated: physicals.some((message) => message.automated),
      weak_subject_blocked: weakSubjectBlocked,
      physical_ids: physicals.map((message) => message.input.id).sort()
    };

    deliveries.push({
      key,
      accountId: representative.input.account_id,
      physicals,
      messageId,
      referenceIds: selectedReferenceIds,
      referenceSource,
      providerThreadKey: providerThreadKeys.length === 1 ? providerThreadKeys[0] : null,
      timestamp: timestampValues[0] ?? null,
      subject: subjectMessage.subject,
      rawSubject: subjectMessage.rawSubject,
      fromEmail: fromMessage.fromEmail,
      recipients,
      automated: normalizedInput.automated,
      weakSubjectBlocked: normalizedInput.weak_subject_blocked,
      warnings: [...warnings].sort(),
      normalizedInputHash: sha256(stableStringify(normalizedInput)),
      nodeKey: ""
    });
  }

  return deliveries.sort((left, right) => binaryCompare(left.key, right.key));
}

class DisjointSet {
  private readonly parents = new Map<string, string>();

  add(value: string): void {
    if (!this.parents.has(value)) this.parents.set(value, value);
  }

  find(value: string): string {
    this.add(value);
    let root = this.parents.get(value) as string;
    while (root !== this.parents.get(root)) root = this.parents.get(root) as string;
    let cursor = value;
    while (cursor !== root) {
      const next = this.parents.get(cursor) as string;
      this.parents.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (binaryCompare(leftRoot, rightRoot) <= 0) this.parents.set(rightRoot, leftRoot);
    else this.parents.set(leftRoot, rightRoot);
  }
}

function wouldCreateCycle(parent: GraphNode, child: GraphNode): boolean {
  // A leaf cannot contain the proposed parent below it. This is the common
  // append-only reply path and keeps a long linear thread O(n), not O(n²).
  if (child.children.size === 0) return false;
  let cursor: GraphNode | null = parent;
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === child) return true;
    if (visited.has(cursor.key)) return true;
    visited.add(cursor.key);
    cursor = cursor.parent;
  }
  return false;
}

function detach(node: GraphNode): void {
  node.parent?.children.delete(node);
  node.parent = null;
}

function attach(parent: GraphNode, child: GraphNode, replace: boolean): boolean {
  if (parent === child || wouldCreateCycle(parent, child)) return false;
  if (child.parent && !replace) return false;
  if (replace) detach(child);
  child.parent = parent;
  parent.children.add(child);
  return true;
}

function reciprocalParticipants(reply: Delivery, root: Delivery): boolean {
  return Boolean(
    reply.fromEmail &&
    root.fromEmail &&
    root.recipients.has(reply.fromEmail) &&
    reply.recipients.has(root.fromEmail)
  );
}

function conversationId(accountId: string, anchor: string): string {
  return `thread_${sha256(`supamail-conversation\u0000${accountId}\u0000${anchor}`).slice(0, 32)}`;
}

function threadAccount(
  inputs: ThreadingMessageInput[],
  options: Required<ThreadingOptions>,
  algorithmVersion: number,
  groupingVersion: 1 | 2 | 3
): ThreadingAssignment[] {
  const accountId = inputs[0]?.account_id;
  if (!accountId) return [];
  const parsed = inputs.map((input) => parsePhysicalMessage(input, groupingVersion));
  const deliveries = buildDeliveries(parsed, groupingVersion);

  const tokenOwners = new Map<string, Delivery[]>();
  for (const delivery of deliveries) {
    if (!delivery.messageId) continue;
    const owners = tokenOwners.get(delivery.messageId) ?? [];
    owners.push(delivery);
    tokenOwners.set(delivery.messageId, owners);
  }
  for (const owners of tokenOwners.values()) owners.sort((left, right) => binaryCompare(left.key, right.key));

  const nodes = new Map<string, GraphNode>();
  const addNode = (
    key: string,
    reference: string | null,
    deliveryKeyValue: string | null,
    placeholder: boolean,
    ambiguous = false
  ): GraphNode => {
    const existing = nodes.get(key);
    if (existing) return existing;
    const node: GraphNode = {
      key,
      reference,
      deliveryKey: deliveryKeyValue,
      placeholder,
      ambiguous,
      parent: null,
      children: new Set()
    };
    nodes.set(key, node);
    return node;
  };

  for (const delivery of deliveries) {
    const uniqueTokenOwner = delivery.messageId && tokenOwners.get(delivery.messageId)?.length === 1;
    delivery.nodeKey = uniqueTokenOwner
      ? `reference:${JSON.stringify(delivery.messageId)}`
      : `delivery:${JSON.stringify(delivery.key)}`;
    // A reused Message-ID has no unique owner. Keep it visible on the output as
    // strict_message_id, but do not use it as either delivery's graph anchor.
    addNode(delivery.nodeKey, uniqueTokenOwner ? delivery.messageId : null, delivery.key, false);
  }

  for (const [token, owners] of tokenOwners) {
    if (owners.length <= 1) continue;
    for (const owner of owners) {
      owner.weakSubjectBlocked = true;
      owner.warnings = [...new Set([...owner.warnings, "ambiguous_message_id_owner"])].sort();
    }
  }

  const referenceNode = (token: string, delivery: Delivery): GraphNode => {
    const owners = tokenOwners.get(token) ?? [];
    if (owners.length === 1) return nodes.get(owners[0].nodeKey) as GraphNode;
    if (owners.length > 1) {
      // A reused Message-ID is not the same thing as a missing parent. Giving
      // every reply the same placeholder would silently merge replies to
      // different physical owners. Preserve the claimed parent as provisional
      // evidence, but isolate it to this delivery until ownership is unique.
      delivery.weakSubjectBlocked = true;
      delivery.warnings = [...new Set([
        ...delivery.warnings,
        "ambiguous_parent_reference_isolated"
      ])].sort();
      return addNode(
        `ambiguous:${JSON.stringify(token)}:${JSON.stringify(delivery.key)}`,
        token,
        null,
        true,
        true
      );
    }
    return addNode(`missing:${JSON.stringify(token)}`, token, null, true);
  };

  const orderedDeliveries = [...deliveries].sort((left, right) => {
    const leftDate = left.timestamp ?? Number.MAX_SAFE_INTEGER;
    const rightDate = right.timestamp ?? Number.MAX_SAFE_INTEGER;
    return leftDate - rightDate || binaryCompare(left.key, right.key);
  });
  const forwardBoundaryNodeKeys = groupingVersion >= 3
    ? new Set(deliveries.filter((delivery) => delivery.subject.isForward)
      .map((delivery) => delivery.nodeKey))
    : new Set<string>();

  for (const delivery of orderedDeliveries) {
    let prior: GraphNode | null = null;
    for (const token of delivery.referenceIds) {
      const current = referenceNode(token, delivery);
      const crossesForwardBoundary = groupingVersion >= 3 && forwardBoundaryNodeKeys.has(current.key);
      if (prior && crossesForwardBoundary) {
        delivery.warnings = [...new Set([
          ...delivery.warnings,
          "forward_ancestry_not_conversation_edge"
        ])].sort();
      }
      if (prior && !current.parent && !crossesForwardBoundary && !attach(prior, current, false)) {
        delivery.warnings = [...new Set([...delivery.warnings, "reference_cycle_ignored"])].sort();
      }
      prior = current;
    }

    if (!prior) continue;
    const current = nodes.get(delivery.nodeKey) as GraphNode;
    // The current message's final reference is stronger than inferred ancestry.
    if (!attach(prior, current, true)) {
      delivery.warnings = [...new Set([...delivery.warnings, "reference_cycle_ignored"])].sort();
    }
  }

  const sets = new DisjointSet();
  for (const node of nodes.values()) sets.add(node.key);
  for (const node of nodes.values()) if (node.parent) sets.union(node.key, node.parent.key);

  // Ambiguous Message-ID owners remain separate. If another message references
  // that ID it attaches to the ambiguity placeholder, never an arbitrary owner.

  const providerGroups = new Map<string, Delivery[]>();
  for (const delivery of deliveries) {
    if (!delivery.providerThreadKey) continue;
    const key = `${accountId}\u0000${delivery.providerThreadKey}`;
    const group = providerGroups.get(key) ?? [];
    group.push(delivery);
    providerGroups.set(key, group);
  }
  const providerConnected = new Set<string>();
  const providerGroupSize = new Map<string, number>();
  const forwardBoundaryComponents = groupingVersion >= 3
    ? new Set(deliveries.filter((delivery) => delivery.subject.isForward)
      .map((delivery) => sets.find(delivery.nodeKey)))
    : new Set<string>();
  for (const group of providerGroups.values()) {
    const members = [...new Map(group.map((delivery) => [delivery.key, delivery])).values()]
      .sort((left, right) => binaryCompare(left.key, right.key));
    const eligible = groupingVersion >= 3
      ? members.filter((member) => !forwardBoundaryComponents.has(sets.find(member.nodeKey)))
      : members;
    const eligibleKeys = new Set(eligible.map((member) => member.key));
    for (const member of members) {
      const included = eligibleKeys.has(member.key);
      providerGroupSize.set(member.key, included ? eligible.length : 1);
      if (!included) {
        member.warnings = [...new Set([
          ...member.warnings,
          "forward_provider_thread_not_conversation_edge"
        ])].sort();
      }
    }
    if (eligible.length <= 1) continue;
    for (const member of eligible) {
      sets.union(eligible[0].nodeKey, member.nodeKey);
      providerConnected.add(member.key);
    }
  }

  // Subject fallback is deliberately last and narrow. Both messages must still
  // be standalone after RFC/provider grouping; the current message must be an
  // actual Re:, not a forward; participants must cross-match in both directions.
  const componentDeliveryCounts = (): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const delivery of deliveries) {
      const root = sets.find(delivery.nodeKey);
      counts.set(root, (counts.get(root) ?? 0) + 1);
    }
    return counts;
  };
  const countsBeforeFallback = componentDeliveryCounts();
  const standalone = deliveries.filter((delivery) => {
    const node = nodes.get(delivery.nodeKey) as GraphNode;
    return countsBeforeFallback.get(sets.find(delivery.nodeKey)) === 1 &&
      !node.parent && node.children.size === 0 &&
      delivery.referenceIds.length === 0 &&
      (providerGroupSize.get(delivery.key) ?? 0) <= 1 &&
      !delivery.automated &&
      !delivery.weakSubjectBlocked &&
      delivery.subject.base !== null;
  });
  const standaloneRoots = options.allowSubjectFallback
    ? standalone.filter((delivery) => !delivery.subject.isReply && !delivery.subject.isForward)
    : [];
  const rootsBySubjectAndRecipient = new Map<string, Map<string, Delivery[]>>();
  for (const root of standaloneRoots) {
    const subjectBase = root.subject.base as string;
    const byRecipient = rootsBySubjectAndRecipient.get(subjectBase) ?? new Map<string, Delivery[]>();
    for (const recipient of root.recipients) {
      const candidates = byRecipient.get(recipient) ?? [];
      candidates.push(root);
      byRecipient.set(recipient, candidates);
    }
    rootsBySubjectAndRecipient.set(subjectBase, byRecipient);
  }
  const fallbackConnections = new Map<string, Set<string>>();
  const fallbackRootKeys = new Set<string>();

  for (const reply of options.allowSubjectFallback ? standalone : []) {
    if (
      !reply.subject.isReply ||
      reply.subject.isForward ||
      reply.timestamp === null ||
      !reply.subject.base ||
      !reply.fromEmail
    ) continue;
    const indexedRoots = rootsBySubjectAndRecipient.get(reply.subject.base)?.get(reply.fromEmail) ?? [];
    const candidates = indexedRoots.filter((root) => {
      if (root.key === reply.key || root.timestamp === null) return false;
      const age = reply.timestamp as number - root.timestamp;
      return age >= 0 && age <= SUBJECT_FALLBACK_WINDOW_MS &&
        root.subject.base === reply.subject.base &&
        reciprocalParticipants(reply, root);
    });
    if (candidates.length !== 1) continue;
    const root = candidates[0];
    sets.union(reply.nodeKey, root.nodeKey);
    fallbackRootKeys.add(root.key);
    const replyLinks = fallbackConnections.get(reply.key) ?? new Set<string>();
    replyLinks.add(root.key);
    fallbackConnections.set(reply.key, replyLinks);
    const rootLinks = fallbackConnections.get(root.key) ?? new Set<string>();
    rootLinks.add(reply.key);
    fallbackConnections.set(root.key, rootLinks);
  }

  const componentNodes = new Map<string, GraphNode[]>();
  for (const node of nodes.values()) {
    const root = sets.find(node.key);
    const group = componentNodes.get(root) ?? [];
    group.push(node);
    componentNodes.set(root, group);
  }
  const componentDeliveries = new Map<string, Delivery[]>();
  for (const delivery of deliveries) {
    const root = sets.find(delivery.nodeKey);
    const group = componentDeliveries.get(root) ?? [];
    group.push(delivery);
    componentDeliveries.set(root, group);
  }

  interface ComponentSummary {
    rootReference: string | null;
    anchor: string;
    id: string;
    provisional: boolean;
  }
  const summaries = new Map<string, ComponentSummary>();
  for (const [root, memberDeliveries] of componentDeliveries) {
    const memberNodes = componentNodes.get(root) ?? [];
    const rootReferences = [...new Set(
      memberNodes.flatMap((node) => node.reference && !node.parent ? [node.reference] : [])
    )].sort();
    const ambiguousRoots = memberNodes
      .filter((node) => node.ambiguous && !node.parent)
      .sort((left, right) => binaryCompare(left.key, right.key));
    const providerAnchors = [...new Set(
      memberDeliveries.flatMap((delivery) =>
        delivery.providerThreadKey && (providerGroupSize.get(delivery.key) ?? 0) > 1
          ? [delivery.providerThreadKey]
          : []
      )
    )].sort();
    const fallbackRoot = memberDeliveries
      .filter((delivery) => fallbackRootKeys.has(delivery.key))
      .sort((left, right) => binaryCompare(left.key, right.key))[0];
    const fallbackRootNode = fallbackRoot ? nodes.get(fallbackRoot.nodeKey) : null;
    const rootReference = fallbackRoot
      ? fallbackRootNode?.reference ?? null
      : rootReferences.length === 1
        ? rootReferences[0]
        : null;
    const anchor = fallbackRoot
      ? rootReference
        ? `reference:${rootReference}`
        : `delivery:${fallbackRoot.key}`
      : rootReference && ambiguousRoots.length === 0
        ? `reference:${rootReference}`
        : providerAnchors.length === 1
          ? `provider:${providerAnchors[0]}`
          : ambiguousRoots.length === 1
            ? `ambiguity:${sha256(ambiguousRoots[0].key)}`
            : `delivery:${memberDeliveries.map((delivery) => delivery.key).sort()[0]}`;
    summaries.set(root, {
      rootReference,
      anchor,
      id: conversationId(accountId, anchor),
      provisional: memberNodes.some((node) => node.placeholder) ||
        memberDeliveries.some((delivery) => fallbackConnections.has(delivery.key))
    });
  }

  const assignments: ThreadingAssignment[] = [];
  for (const delivery of deliveries) {
    const node = nodes.get(delivery.nodeKey) as GraphNode;
    const componentRoot = sets.find(delivery.nodeKey);
    const summary = summaries.get(componentRoot) as ComponentSummary;
    const hasReferenceRelationship = Boolean(node.parent || node.children.size > 0);
    let method: ThreadingMethod;
    if (delivery.referenceSource === "references" && delivery.referenceIds.length > 0 && node.parent) {
      method = "references";
    } else if (delivery.referenceSource === "in_reply_to" && delivery.referenceIds.length > 0 && node.parent) {
      method = "in_reply_to";
    } else if (hasReferenceRelationship) {
      method = "references";
    } else if (providerConnected.has(delivery.key)) {
      method = "provider_thread";
    } else if (fallbackConnections.has(delivery.key)) {
      method = "subject_fallback";
    } else {
      method = "standalone";
    }
    const confidence: ThreadingConfidence = summary.provisional
      ? "low"
      : method === "provider_thread"
        ? "medium"
        : "high";

    const evidence: ThreadingEvidence = {
      header_source: delivery.referenceSource,
      provider_thread_key: delivery.providerThreadKey,
      subject_fallback_keys: [...(fallbackConnections.get(delivery.key) ?? [])].sort(),
      collapsed_physical_ids: delivery.physicals.map((message) => message.input.id).sort(),
      parse_warnings: [...delivery.warnings].sort()
    };
    const parentReference = node.parent?.reference ?? null;
    const parentDeliveryKey = node.parent?.deliveryKey ?? null;
    const assignmentHash = sha256(stableStringify({
      algorithm_version: algorithmVersion,
      normalized_input_hash: delivery.normalizedInputHash,
      conversation_anchor: summary.anchor,
      parent_reference: parentReference,
      parent_delivery_key: parentDeliveryKey,
      reference_ids: delivery.referenceIds,
      method,
      confidence,
      provisional: summary.provisional,
      evidence
    }));

    for (const physical of delivery.physicals) {
      assignments.push({
        physical_message_id: physical.input.id,
        account_id: accountId,
        delivery_key: delivery.key,
        conversation_id: summary.id,
        conversation_anchor: summary.anchor,
        root_reference: summary.rootReference,
        parent_reference: parentReference,
        parent_delivery_key: parentDeliveryKey,
        reference_ids: [...delivery.referenceIds],
        strict_message_id: delivery.messageId,
        subject_base: delivery.subject.base,
        provider_thread_key: delivery.providerThreadKey,
        method,
        confidence,
        provisional: summary.provisional,
        evidence: {
          ...evidence,
          subject_fallback_keys: [...evidence.subject_fallback_keys],
          collapsed_physical_ids: [...evidence.collapsed_physical_ids],
          parse_warnings: [...evidence.parse_warnings]
        },
        input_hash: assignmentHash,
        algorithm_version: algorithmVersion
      });
    }
  }

  return assignments.sort((left, right) =>
    binaryCompare(left.account_id, right.account_id) ||
    binaryCompare(left.physical_message_id, right.physical_message_id)
  );
}

function computeThreadAssignmentsForVersion(
  messages: readonly ThreadingMessageInput[],
  options: ThreadingOptions,
  algorithmVersion: number,
  groupingVersion: 1 | 2 | 3
): ThreadingAssignment[] {
  const physicalIds = new Set<string>();
  const accounts = new Map<string, ThreadingMessageInput[]>();
  for (const message of messages) {
    if (!message.account_id.trim()) throw new Error("threading requires a non-empty account_id");
    if (!message.id.trim()) throw new Error("threading requires a non-empty physical message id");
    const physicalIdentity = `${message.account_id}\u0000${message.id}`;
    if (physicalIds.has(physicalIdentity)) {
      throw new Error(`duplicate physical message id in account: ${message.id}`);
    }
    physicalIds.add(physicalIdentity);
    const group = accounts.get(message.account_id) ?? [];
    group.push(message);
    accounts.set(message.account_id, group);
  }

  const resolvedOptions: Required<ThreadingOptions> = {
    allowSubjectFallback: options.allowSubjectFallback ?? true
  };

  return [...accounts.entries()]
    .sort(([left], [right]) => binaryCompare(left, right))
    .flatMap(([, accountMessages]) =>
      threadAccount(accountMessages, resolvedOptions, algorithmVersion, groupingVersion)
    );
}

/** Retained verbatim v1 behavior for active, standby, and rollback runs. */
export function computeThreadAssignmentsV1(
  messages: readonly ThreadingMessageInput[],
  options: ThreadingOptions = {}
): ThreadingAssignment[] {
  return computeThreadAssignmentsForVersion(messages, options, 1, 1);
}

/** Retained verbatim v2 behavior for active, standby, and rollback runs. */
export function computeThreadAssignmentsV2(
  messages: readonly ThreadingMessageInput[],
  options: ThreadingOptions = {}
): ThreadingAssignment[] {
  return computeThreadAssignmentsForVersion(messages, options, 2, 2);
}

/** Build deterministic assignments for any number of accounts. */
export function computeThreadAssignments(
  messages: readonly ThreadingMessageInput[],
  options: ThreadingOptions = {}
): ThreadingAssignment[] {
  return computeThreadAssignmentsForVersion(
    messages,
    options,
    THREADING_ALGORITHM_VERSION,
    THREADING_ALGORITHM_VERSION
  );
}

/** Short alias for callers that model this as a pure threading pass. */
export const threadMessages = computeThreadAssignments;
