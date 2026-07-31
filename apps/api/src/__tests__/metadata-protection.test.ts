import { describe, expect, it } from "vitest";
import {
  MAX_PROTECTED_METADATA_ENVELOPE_BYTES,
  PlaintextMetadataProtectionAdapter,
  assertMetadataProtectionProjection,
  assertRevealedMetadataValues,
  protectedMetadataColumns,
  storedMetadataProjection,
  type MetadataProtectionAdapter,
  type MetadataProtectionProjection,
  type MetadataValues
} from "../metadata-protection.js";
import { ThreadingRepository } from "../threading-repository.js";

const context = {
  kind: "message" as const,
  accountId: "00000000-0000-4000-8000-000000000001",
  recordId: "00000000-0000-4000-8000-000000000002"
};

describe("metadata protection seam", () => {
  it("keeps readable metadata as the OSS and BYO default", async () => {
    const adapter = new PlaintextMetadataProtectionAdapter();
    const values = { subject: "Quarterly plan", from_email: "sender@example.com" };

    const protectedValue = await adapter.protect(context, values);
    const revealed = await adapter.reveal(context, protectedValue);

    expect(protectedValue).toEqual({
      values,
      protectedMetadata: null,
      envelopeVersion: null,
      keyVersion: null,
      tokens: null
    });
    expect(protectedValue.values).not.toBe(values);
    expect(revealed).toEqual(values);
    expect(revealed).not.toBe(protectedValue.values);
  });

  it("fails closed when the plaintext adapter receives protected metadata", async () => {
    const adapter = new PlaintextMetadataProtectionAdapter();

    await expect(adapter.reveal(context, {
      values: { subject: "opaque-token" },
      protectedMetadata: Buffer.from("ciphertext"),
      envelopeVersion: 1,
      keyVersion: 7,
      tokens: { subject: "opaque-token" }
    })).rejects.toThrow("plaintext metadata adapter cannot reveal protected metadata");
  });

  it("maps opaque adapter output to and from generic storage columns", () => {
    const envelope = Buffer.from("ciphertext");
    const columns = protectedMetadataColumns({
      values: { subject: null },
      protectedMetadata: envelope,
      envelopeVersion: 1,
      keyVersion: 7,
      tokens: { subject: "opaque-token" }
    });

    expect(columns).toEqual({
      protected_metadata: envelope,
      protected_metadata_version: 1,
      protected_metadata_key_version: 7,
      protected_metadata_tokens: { subject: "opaque-token" }
    });
    expect(storedMetadataProjection(columns, { subject: null })).toEqual({
      values: { subject: null },
      protectedMetadata: envelope,
      envelopeVersion: 1,
      keyVersion: 7,
      tokens: { subject: "opaque-token" }
    });
  });

  it("rejects partial or invalid protected projections", () => {
    expect(() => assertMetadataProtectionProjection({
      values: {},
      protectedMetadata: Buffer.from("ciphertext"),
      envelopeVersion: null,
      keyVersion: 1,
      tokens: null
    })).toThrow("envelope fields must be present or absent together");

    expect(() => assertMetadataProtectionProjection({
      values: {},
      protectedMetadata: Buffer.from("ciphertext"),
      envelopeVersion: 1,
      keyVersion: 0,
      tokens: null
    })).toThrow("key version must fit a positive PostgreSQL integer");

    expect(() => assertMetadataProtectionProjection({
      values: {},
      protectedMetadata: Buffer.from("ciphertext"),
      envelopeVersion: 32_768,
      keyVersion: 1,
      tokens: null
    })).toThrow("envelope version must fit a positive PostgreSQL smallint");

    expect(() => assertMetadataProtectionProjection({
      values: {},
      protectedMetadata: Buffer.from("ciphertext"),
      envelopeVersion: 1,
      keyVersion: 2_147_483_648,
      tokens: null
    })).toThrow("key version must fit a positive PostgreSQL integer");

    expect(() => assertMetadataProtectionProjection({
      values: {},
      protectedMetadata: Buffer.from("ciphertext"),
      envelopeVersion: 1,
      keyVersion: 1,
      tokens: { invalid: 1 } as never
    })).toThrow("token values must be strings");

    expect(() => assertMetadataProtectionProjection({
      values: {},
      protectedMetadata: null,
      envelopeVersion: null,
      keyVersion: null,
      tokens: { subject: "opaque-token" }
    })).toThrow("tokens require an envelope");

    expect(() => assertMetadataProtectionProjection({
      values: {},
      protectedMetadata: Buffer.alloc(MAX_PROTECTED_METADATA_ENVELOPE_BYTES + 1),
      envelopeVersion: 1,
      keyVersion: 1,
      tokens: null
    })).toThrow(`envelope exceeds ${MAX_PROTECTED_METADATA_ENVELOPE_BYTES} bytes`);

    expect(() => assertMetadataProtectionProjection({
      values: { subject: null },
      protectedMetadata: null,
      envelopeVersion: null,
      keyVersion: null,
      tokens: null
    }, ["subject", "from_email"])).toThrow("must contain exactly the input fields");

    expect(() => assertMetadataProtectionProjection({
      values: { subject: null, id: "injected" },
      protectedMetadata: null,
      envelopeVersion: null,
      keyVersion: null,
      tokens: null
    }, ["subject"])).toThrow("must contain exactly the input fields");

    expect(() => assertRevealedMetadataValues(
      { subject: "token" },
      ["subject", "from_email"]
    )).toThrow("must contain every requested field");

    expect(() => assertRevealedMetadataValues(
      [] as never,
      ["subject"]
    )).toThrow("must be a plain object");
  });

  it("bounds protected threading write payloads and drops envelopes after persistence", async () => {
    let protects = 0;
    const adapter: MetadataProtectionAdapter = {
      async protect(_context, values): Promise<MetadataProtectionProjection> {
        protects += 1;
        return {
          values: { ...values },
          protectedMetadata: Buffer.alloc(MAX_PROTECTED_METADATA_ENVELOPE_BYTES, 1),
          envelopeVersion: 1,
          keyVersion: 1,
          tokens: null
        };
      },
      async reveal(_context, stored): Promise<MetadataValues> {
        return { ...stored.values };
      }
    };
    const repository = new ThreadingRepository({} as never, {
      metadataProtection: adapter
    });
    const payloadBytes: number[] = [];
    const client = {
      query: async (_sql: string, params: unknown[] = []) => {
        payloadBytes.push(Buffer.byteLength(String(params[0])));
        return { rows: [] };
      }
    };
    const records = Array.from({ length: 17 }, (_, index) => ({
      run_id: "00000000-0000-4000-8000-000000000001",
      message_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      account_id: "00000000-0000-4000-8000-000000000002",
      delivery_key: `delivery-${index}`,
      strict_message_id: `message-${index}@example.test`,
      strict_message_id_hash: `strict-${index}`,
      conversation_id: `thread-${index}`,
      root_reference: null,
      root_reference_hash: null,
      parent_reference: null,
      parent_reference_hash: null,
      parent_delivery_key: null,
      reference_ids: [],
      reference_hashes: [],
      delivery_fingerprint_hashes: [],
      subject_base: `Subject ${index}`,
      subject_key: `subject-${index}`,
      participant_edge_hashes: [],
      provider_thread_key: null,
      provider_thread_hash: null,
      assignment_method: "strict",
      confidence: "high",
      is_provisional: false,
      subject_fallback_eligible: false,
      algorithm_version: 1,
      input_hash: `input-${index}`,
      generation: "1",
      evidence: {}
    }));
    const upsertAssignments = (
      repository as unknown as {
        upsertAssignments(
          target: typeof client,
          values: typeof records
        ): Promise<Array<Record<string, unknown>>>;
      }
    ).upsertAssignments.bind(repository);

    const persisted = await upsertAssignments(client, records);

    expect(protects).toBe(records.length);
    expect(payloadBytes.length).toBeGreaterThan(1);
    expect(Math.max(...payloadBytes)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(persisted).toHaveLength(records.length);
    expect(persisted.every((row) => !Object.hasOwn(row, "protected_metadata_base64"))).toBe(true);
  });
});
