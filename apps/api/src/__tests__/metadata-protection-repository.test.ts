import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { PgPool } from "../db.js";
import type {
  MetadataProtectionAdapter,
  MetadataProtectionContext,
  MetadataProtectionProjection,
  MetadataValues
} from "../metadata-protection.js";
import { MirrorRepository } from "../repository.js";

vi.mock("../host-validation.js", () => ({
  assertSafeImapTarget: vi.fn(async () => undefined)
}));

vi.mock("../crypto.js", () => ({
  encryptPassword: vi.fn(async () => Buffer.from("encrypted-password"))
}));

class RecordingProtectionAdapter implements MetadataProtectionAdapter {
  readonly writes: Array<{ context: MetadataProtectionContext; values: MetadataValues }> = [];
  private readonly plaintext = new Map<string, MetadataValues>();

  async protect(
    context: MetadataProtectionContext,
    values: MetadataValues
  ): Promise<MetadataProtectionProjection> {
    this.writes.push({ context, values });
    this.plaintext.set(`${context.kind}:${context.recordId}`, { ...values });
    return {
      values: {
        email_address: "opaque-email-token",
        username: "opaque-username-token",
        smtp_username: null
      },
      protectedMetadata: Buffer.from("opaque-envelope"),
      envelopeVersion: 1,
      keyVersion: 3,
      tokens: { email: "opaque-token" }
    };
  }

  async reveal(
    context: MetadataProtectionContext
  ): Promise<MetadataValues> {
    return this.plaintext.get(`${context.kind}:${context.recordId}`) ?? {};
  }
}

describe("MirrorRepository metadata protection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores adapter output and returns the revealed Mailbox Account", async () => {
    let insertParams: unknown[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
        if (sql.includes("INSERT INTO public.imap_accounts")) {
          insertParams = params;
          return {
            rows: [{
              id: params[13],
              email_address: params[0],
              protected_metadata: params[14],
              protected_metadata_version: params[15],
              protected_metadata_key_version: params[16],
              protected_metadata_tokens: params[17]
            }]
          };
        }
        return { rows: [] };
      })
    } as unknown as PgPool;
    const adapter = new RecordingProtectionAdapter();
    const repository = new MirrorRepository(pool, {
      SYNC_MAX_ACCOUNTS: 10,
      BODY_FETCH_POLICY: "lazy",
      IMAP_ENCRYPTION_KEY: "0123456789abcdef"
    } as AppConfig, adapter);

    const account = await repository.createAccount({
      emailAddress: "owner@example.com",
      host: "imap.example.com",
      port: 993,
      secure: true,
      username: "owner@example.com",
      password: "not-stored-in-plaintext"
    });

    expect(adapter.writes).toHaveLength(1);
    expect(adapter.writes[0]?.context).toEqual({
      kind: "account",
      accountId: account.id,
      recordId: account.id
    });
    expect(insertParams[0]).toBe("opaque-email-token");
    expect(insertParams[5]).toBe("opaque-username-token");
    expect(insertParams[14]).toEqual(Buffer.from("opaque-envelope"));
    expect(insertParams.slice(15, 18)).toEqual([
      1,
      3,
      { email: "opaque-token" }
    ]);
    expect(insertParams[18]).toBe("protected");
    expect(account.email_address).toBe("owner@example.com");
    expect(account).not.toHaveProperty("protected_metadata");
    expect(account).not.toHaveProperty("protected_metadata_tokens");
  });

  it("marks accounts as plaintext when no protection adapter is configured", async () => {
    let insertParams: unknown[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
        if (sql.includes("INSERT INTO public.imap_accounts")) {
          insertParams = params;
          return {
            rows: [{
              id: params[13],
              email_address: params[0],
              protected_metadata: params[14],
              protected_metadata_version: params[15],
              protected_metadata_key_version: params[16],
              protected_metadata_tokens: params[17]
            }]
          };
        }
        return { rows: [] };
      })
    } as unknown as PgPool;
    const repository = new MirrorRepository(pool, {
      SYNC_MAX_ACCOUNTS: 10,
      BODY_FETCH_POLICY: "lazy",
      IMAP_ENCRYPTION_KEY: "0123456789abcdef"
    } as AppConfig);

    await repository.createAccount({
      emailAddress: "owner@example.com",
      host: "imap.example.com",
      port: 993,
      secure: true,
      username: "owner@example.com",
      password: "not-stored-in-plaintext"
    });

    expect(insertParams[18]).toBe("plaintext");
  });
});
