export const METADATA_RECORD_KINDS = [
  "account",
  "message",
  "message_body",
  "attachment",
  "message_evidence",
  "thread_assignment",
  "thread_assignment_history"
] as const;

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

export interface MetadataProtectionProjection {
  /**
   * Values that public core persists in the normal relation columns.
   * They must satisfy the relation's existing nullability and CHECK constraints.
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
  protect(
    context: MetadataProtectionContext,
    values: MetadataValues
  ): Promise<MetadataProtectionProjection>;

  reveal(
    context: MetadataProtectionContext,
    stored: MetadataProtectionProjection
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
    return { ...stored.values };
  }
}

export const plaintextMetadataProtection = new PlaintextMetadataProtectionAdapter();

const POSTGRES_SMALLINT_MAX = 32_767;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

export function assertMetadataProtectionProjection(
  projection: MetadataProtectionProjection
): void {
  const hasEnvelope = projection.protectedMetadata !== null;
  if (hasEnvelope !== (projection.envelopeVersion !== null)
    || hasEnvelope !== (projection.keyVersion !== null)) {
    throw new Error("metadata protection envelope fields must be present or absent together");
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
