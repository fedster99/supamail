import { createHash } from "node:crypto";

export const MIME_EVIDENCE_EXTRACTOR = "mime_body";
export const MIME_EVIDENCE_EXTRACTOR_VERSION = "mime_evidence_v2";
/**
 * v1 hashed each evidence row's own message id into structured_evidence_sha256,
 * so two stored copies of one email never shared an authored delivery digest.
 * Its evidence rows are still current: the threading lane upgrades the digests
 * in place, and body sync must not fetch these bodies again.
 */
export const DIGEST_UPGRADE_EVIDENCE_EXTRACTOR_VERSION = "mime_evidence_v1";
export const EVIDENCE_VERSIONS_WITHOUT_REFETCH = [
  MIME_EVIDENCE_EXTRACTOR_VERSION,
  DIGEST_UPGRADE_EVIDENCE_EXTRACTOR_VERSION
] as const;

export interface EvidenceIdentity {
  kind: string;
  namespace: string;
  evidence_key_sha256: string;
  metadata: unknown;
}

export function canonicalJsonForThreadingEvidence(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) {
    return `[${value.map((entry) => entry === undefined ? "null" : canonicalJsonForThreadingEvidence(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalJsonForThreadingEvidence(entry)}`
    )).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function evidenceIdentity(row: EvidenceIdentity): string {
  return `${row.kind}\u0000${row.namespace}\u0000${row.evidence_key_sha256}`;
}

/**
 * Digest of what a message's structured evidence is, not of which rows hold
 * it, so every stored copy of one email gets the same value.
 */
export function structuredEvidenceSha256(rows: readonly EvidenceIdentity[]): string {
  const content = rows
    .map(({ kind, namespace, evidence_key_sha256, metadata }) => ({
      kind, namespace, evidence_key_sha256, metadata
    }))
    .sort((left, right) => {
      const leftIdentity = evidenceIdentity(left);
      const rightIdentity = evidenceIdentity(right);
      return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
    });
  return createHash("sha256").update(canonicalJsonForThreadingEvidence(content)).digest("hex");
}

/** SQL expressions, already typed, for the inputs of the authored delivery digest. */
export interface AuthoredDeliveryDigestInputs {
  headersJson: string;
  subject: string;
  fromEmail: string;
  toEmails: string;
  ccEmails: string;
  bccEmails: string;
  threadingPayloadSha256: string;
  mimeStructure: string;
  parserWarnings: string;
  structuredEvidenceSha256: string;
}

/**
 * The transport-invariant authored delivery digest. Every writer builds its SQL
 * here, so the same email always gets the same digest.
 */
export function authoredDeliveryDigestSql(input: AuthoredDeliveryDigestInputs): string {
  return `encode(extensions.digest(convert_to(jsonb_build_object(
    'message_id', ${input.headersJson} -> 'message-id',
    'date', ${input.headersJson} -> 'date',
    'subject', ${input.subject},
    'from_email', ${input.fromEmail},
    'to_emails', ${input.toEmails},
    'cc_emails', ${input.ccEmails},
    'bcc_emails', ${input.bccEmails},
    'threading_payload_sha256', ${input.threadingPayloadSha256},
    'content_type', ${input.headersJson} -> 'content-type',
    'content_transfer_encoding', ${input.headersJson} -> 'content-transfer-encoding',
    'mime_version', ${input.headersJson} -> 'mime-version',
    'mime_structure', ${input.mimeStructure},
    'parser_warnings', ${input.parserWarnings},
    'structured_evidence_sha256', ${input.structuredEvidenceSha256}
  )::text, 'UTF8'), 'sha256'), 'hex')`;
}
