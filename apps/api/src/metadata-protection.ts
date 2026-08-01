export const METADATA_RECORD_KINDS = [
  "account",
  "message",
  "message_body",
  "attachment",
  "message_evidence",
  "thread_assignment",
  "thread_assignment_history"
] as const;

export const METADATA_PROTECTED_FIELDS = Object.freeze({
  account: ["email_address", "username", "smtp_username"],
  accountSummary: ["email_address"],
  message: [
    "rfc_message_id",
    "message_id_normalized",
    "provider_message_id",
    "provider_message_id_namespace",
    "provider_thread_id",
    "provider_thread_id_namespace",
    "in_reply_to",
    "references_header",
    "subject",
    "from_email",
    "from_name",
    "to_emails",
    "to_names",
    "cc_emails",
    "cc_names",
    "bcc_emails",
    "headers_json",
    "mime_structure"
  ],
  messageBody: [
    "raw_mime_sha256",
    "parsed_delivery_sha256",
    "authored_delivery_sha256",
    "headers_json",
    "mime_structure",
    "parser_warnings",
    "structured_evidence_sha256",
    "threading_payload_sha256",
    "search_extract"
  ],
  attachment: ["filename", "content_id"]
} as const);

export type MetadataRecordKind = typeof METADATA_RECORD_KINDS[number];
export type MetadataValues = Record<string, unknown>;

export interface MetadataProtectionContext {
  kind: MetadataRecordKind;
  accountId: string;
  /**
   * Stable identity within the relation.
   * UUID-backed rows use their UUID. Composite-key rows use their canonical key.
   */
  recordId: string;
}

export interface MetadataProtectionOperationOptions {
  /** The caller aborts this signal when the bounded storage operation expires. */
  signal?: AbortSignal;
}

export interface MetadataProtectionProjection {
  /**
   * Values that public core persists in the normal relation columns.
   * They must satisfy the relation's existing nullability and CHECK constraints.
   * Fields used for equality or uniqueness must also use stable projections that
   * preserve those database semantics.
   */
  values: MetadataValues;
  /** Opaque application-layer ciphertext. Null means readable identity storage. */
  protectedMetadata: Buffer | null;
  envelopeVersion: number | null;
  keyVersion: number | null;
  /**
   * Opaque exact-match tokens.
   * Public core stores them but never interprets their names or values.
   */
  tokens: Record<string, string> | null;
}

export interface MetadataProtectionAdapter {
  /** Durable write mode. A plaintext-mode adapter may still read protected rows during migration. */
  readonly storageMode?: "plaintext" | "protected";
  /**
   * A protected adapter must authenticate kind, accountId, recordId, envelope
   * version, and key version as unambiguous associated data.
   */
  protect(
    context: MetadataProtectionContext,
    values: MetadataValues,
    options?: MetadataProtectionOperationOptions
  ): Promise<MetadataProtectionProjection>;

  reveal(
    context: MetadataProtectionContext,
    stored: MetadataProtectionProjection,
    options?: MetadataProtectionOperationOptions
  ): Promise<MetadataValues>;
}

export interface ProtectedMetadataColumns {
  protected_metadata: Buffer | null;
  protected_metadata_version: number | null;
  protected_metadata_key_version: number | null;
  protected_metadata_tokens: Record<string, string> | null;
}

export const EMPTY_PROTECTED_METADATA_COLUMNS: ProtectedMetadataColumns = Object.freeze({
  protected_metadata: null,
  protected_metadata_version: null,
  protected_metadata_key_version: null,
  protected_metadata_tokens: null
});

export class PlaintextMetadataProtectionAdapter implements MetadataProtectionAdapter {
  readonly storageMode = "plaintext" as const;
  async protect(
    _context: MetadataProtectionContext,
    values: MetadataValues
  ): Promise<MetadataProtectionProjection> {
    return {
      values: { ...values },
      protectedMetadata: null,
      envelopeVersion: null,
      keyVersion: null,
      tokens: null
    };
  }

  async reveal(
    _context: MetadataProtectionContext,
    stored: MetadataProtectionProjection
  ): Promise<MetadataValues> {
    if (stored.protectedMetadata !== null
      || stored.envelopeVersion !== null
      || stored.keyVersion !== null
      || stored.tokens !== null) {
      throw new Error("plaintext metadata adapter cannot reveal protected metadata");
    }
    return { ...stored.values };
  }
}

export const plaintextMetadataProtection = new PlaintextMetadataProtectionAdapter();

export function isPlaintextMetadataProtectionAdapter(
  adapter: MetadataProtectionAdapter
): boolean {
  if (adapter.storageMode === "plaintext") return true;
  if (adapter.storageMode === "protected") return false;
  return adapter instanceof PlaintextMetadataProtectionAdapter;
}

export function usesPlaintextMetadataStorage(
  adapter: MetadataProtectionAdapter,
  row: Partial<ProtectedMetadataColumns>
): boolean {
  return isPlaintextMetadataProtectionAdapter(adapter)
    && row.protected_metadata == null
    && row.protected_metadata_version == null
    && row.protected_metadata_key_version == null
    && row.protected_metadata_tokens == null;
}

const POSTGRES_SMALLINT_MAX = 32_767;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
export const MAX_PROTECTED_METADATA_ENVELOPE_BYTES = 512 * 1024;

export function assertMetadataProtectionProjection(
  projection: MetadataProtectionProjection,
  expectedFields?: readonly string[]
): void {
  const valuesPrototype = projection.values === null || typeof projection.values !== "object"
    ? null
    : Object.getPrototypeOf(projection.values);
  if (projection.values === null
    || Array.isArray(projection.values)
    || typeof projection.values !== "object"
    || (valuesPrototype !== Object.prototype && valuesPrototype !== null)) {
    throw new Error("metadata protection values must be a plain object");
  }
  if (expectedFields) {
    const actualFields = Object.keys(projection.values).sort();
    const requiredFields = [...expectedFields].sort();
    if (actualFields.length !== requiredFields.length
      || actualFields.some((field, index) => field !== requiredFields[index])) {
      throw new Error("metadata protection values must contain exactly the input fields");
    }
  }
  const hasEnvelope = projection.protectedMetadata !== null;
  if (hasEnvelope && !Buffer.isBuffer(projection.protectedMetadata)) {
    throw new Error("metadata protection envelope must be a Buffer or null");
  }
  if (projection.protectedMetadata
    && projection.protectedMetadata.byteLength > MAX_PROTECTED_METADATA_ENVELOPE_BYTES) {
    throw new Error(
      `metadata protection envelope exceeds ${MAX_PROTECTED_METADATA_ENVELOPE_BYTES} bytes`
    );
  }
  if (hasEnvelope !== (projection.envelopeVersion !== null)
    || hasEnvelope !== (projection.keyVersion !== null)) {
    throw new Error("metadata protection envelope fields must be present or absent together");
  }
  if (!hasEnvelope && projection.tokens !== null) {
    throw new Error("metadata protection tokens require an envelope");
  }
  if (projection.envelopeVersion !== null
    && (!Number.isSafeInteger(projection.envelopeVersion)
      || projection.envelopeVersion <= 0
      || projection.envelopeVersion > POSTGRES_SMALLINT_MAX)) {
    throw new Error("metadata protection envelope version must fit a positive PostgreSQL smallint");
  }
  if (projection.keyVersion !== null
    && (!Number.isSafeInteger(projection.keyVersion)
      || projection.keyVersion <= 0
      || projection.keyVersion > POSTGRES_INTEGER_MAX)) {
    throw new Error("metadata protection key version must fit a positive PostgreSQL integer");
  }
  if (projection.tokens !== null
    && (Array.isArray(projection.tokens) || typeof projection.tokens !== "object")) {
    throw new Error("metadata protection tokens must be an object or null");
  }
  if (projection.tokens !== null
    && Object.values(projection.tokens).some((value) => typeof value !== "string")) {
    throw new Error("metadata protection token values must be strings");
  }
}

export function assertRevealedMetadataValues(
  values: MetadataValues,
  requiredFields: readonly string[]
): void {
  const valuesPrototype = values === null || typeof values !== "object"
    ? null
    : Object.getPrototypeOf(values);
  if (values === null
    || Array.isArray(values)
    || typeof values !== "object"
    || (valuesPrototype !== Object.prototype && valuesPrototype !== null)) {
    throw new Error("revealed metadata values must be a plain object");
  }
  if (requiredFields.some((field) => !Object.hasOwn(values, field))) {
    throw new Error("revealed metadata values must contain every requested field");
  }
}

export function protectedMetadataColumns(
  projection: MetadataProtectionProjection
): ProtectedMetadataColumns {
  assertMetadataProtectionProjection(projection);
  return {
    protected_metadata: projection.protectedMetadata,
    protected_metadata_version: projection.envelopeVersion,
    protected_metadata_key_version: projection.keyVersion,
    protected_metadata_tokens: projection.tokens
  };
}

export function storedMetadataProjection(
  row: ProtectedMetadataColumns,
  values: MetadataValues
): MetadataProtectionProjection {
  const projection = {
    values,
    protectedMetadata: row.protected_metadata ?? null,
    envelopeVersion: row.protected_metadata_version ?? null,
    keyVersion: row.protected_metadata_key_version ?? null,
    tokens: row.protected_metadata_tokens ?? null
  };
  assertMetadataProtectionProjection(projection);
  return projection;
}

/**
 * Reveal one durable row after a read. Public serving helpers use this shared
 * boundary so deployments can inject protection without wrapping arbitrary SQL.
 */
export async function revealMetadataRecord<T extends ProtectedMetadataColumns>(
  adapter: MetadataProtectionAdapter,
  context: MetadataProtectionContext,
  row: T,
  fields: readonly string[]
): Promise<T> {
  const record = row as unknown as Record<string, unknown>;
  const values = Object.fromEntries(fields.map((field) => [field, record[field]]));
  const revealed = usesPlaintextMetadataStorage(adapter, row)
    ? values
    : await adapter.reveal(context, storedMetadataProjection(row, values));
  assertRevealedMetadataValues(revealed, fields);
  const result = { ...record };
  for (const field of fields) result[field] = revealed[field];
  delete result.protected_metadata;
  delete result.protected_metadata_version;
  delete result.protected_metadata_key_version;
  delete result.protected_metadata_tokens;
  return result as unknown as T;
}
