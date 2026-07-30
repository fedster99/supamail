import { describe, expect, it } from "vitest";
import {
  PlaintextMetadataProtectionAdapter,
  assertMetadataProtectionProjection,
  protectedMetadataColumns,
  storedMetadataProjection
} from "../metadata-protection.js";

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
      protectedMetadata: null,
      envelopeVersion: null,
      keyVersion: null,
      tokens: { invalid: 1 } as never
    })).toThrow("token values must be strings");
  });
});
