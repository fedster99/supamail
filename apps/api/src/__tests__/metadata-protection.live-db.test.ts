import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getConfig } from "../config.js";
import { closePool, getPool } from "../db.js";
import type {
  MetadataProtectionAdapter,
  MetadataProtectionContext,
  MetadataProtectionProjection,
  MetadataValues
} from "../metadata-protection.js";
import { MirrorRepository } from "../repository.js";
import type { ImapFolder, MessageMetadata } from "../types.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

function token(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * This adapter proves the storage seam. It is not production encryption.
 * The Cloud repository owns the real key and envelope implementation.
 */
class OpaqueTestAdapter implements MetadataProtectionAdapter {
  async protect(
    context: MetadataProtectionContext,
    values: MetadataValues
  ): Promise<MetadataProtectionProjection> {
    const stored: MetadataValues =
      Object.fromEntries(Object.keys(values).map((field) => [field, null]));
    for (const field of ["headers_json", "metadata"]) {
      if (Object.hasOwn(values, field)) stored[field] = {};
    }
    if (Object.hasOwn(values, "parser_warnings")) stored.parser_warnings = [];
    for (const field of [
      "email_address",
      "message_id_normalized",
      "provider_message_id",
      "provider_thread_id",
      "raw_mime_sha256",
      "parsed_delivery_sha256",
      "authored_delivery_sha256",
      "structured_evidence_sha256",
      "threading_payload_sha256",
      "evidence_key",
      "evidence_key_sha256"
    ]) {
      if (Object.hasOwn(values, field)) stored[field] = token(values[field]);
    }
    return {
      values: stored,
      protectedMetadata: Buffer.from(JSON.stringify({ context, values })),
      envelopeVersion: 1,
      keyVersion: 1,
      tokens: { test: token(values) ?? "" }
    };
  }

  async reveal(
    context: MetadataProtectionContext,
    stored: MetadataProtectionProjection
  ): Promise<MetadataValues> {
    if (!stored.protectedMetadata) return { ...stored.values };
    const envelope = JSON.parse(stored.protectedMetadata.toString("utf8")) as {
      context: MetadataProtectionContext;
      values: MetadataValues;
    };
    if (JSON.stringify(envelope.context) !== JSON.stringify(context)) {
      throw new Error("test adapter context mismatch");
    }
    return envelope.values;
  }
}

class PartialBodyRevealAdapter extends OpaqueTestAdapter {
  override async reveal(
    context: MetadataProtectionContext,
    stored: MetadataProtectionProjection
  ): Promise<MetadataValues> {
    const values = await super.reveal(context, stored);
    if (context.kind !== "message_body") return values;
    const { search_extract: _omitted, ...partial } = values;
    return partial;
  }
}

liveDb("metadata-protection repository seam", () => {
  let pool: ReturnType<typeof getPool>;
  const accountIds = new Set<string>();

  beforeAll(() => {
    pool = getPool();
  });

  afterAll(async () => {
    for (const accountId of accountIds) {
      await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    }
    await closePool();
  });

  it("stores opaque message, attachment, body, and evidence metadata", async () => {
    const email = `metadata-protection-${randomUUID()}@example.test`;
    const account = await pool.query<{ id: string }>(
      `INSERT INTO public.imap_accounts (
         email_address, host, port, username, encrypted_password
       ) VALUES ($1, 'imap.example.test', 993, $1, $2)
       RETURNING id`,
      [email, Buffer.from([0])]
    );
    const accountId = account.rows[0].id;
    accountIds.add(accountId);
    const folderResult = await pool.query<ImapFolder>(
      `INSERT INTO public.imap_folders (account_id, path, tracked)
       VALUES ($1, 'INBOX', true)
       RETURNING *`,
      [accountId]
    );
    const folder = folderResult.rows[0];
    const metadata: MessageMetadata = {
      uid: 1,
      internalDate: new Date("2026-01-02T03:04:05.000Z"),
      sizeBytes: 256,
      flags: [],
      rfcMessageId: "<private-message@example.test>",
      messageIdNormalized: "private-message@example.test",
      providerMessageId: null,
      providerMessageIdNamespace: null,
      providerThreadId: null,
      providerThreadIdNamespace: null,
      inReplyTo: "<private-parent@example.test>",
      referencesHeader: "<private-root@example.test>",
      subject: "Private subject",
      fromEmail: "sender@example.test",
      fromName: "Sender",
      toEmails: [email],
      toNames: [null],
      ccEmails: [],
      ccNames: [],
      bccEmails: [],
      headersJson: { "message-id": "<protected@example.test>" },
      mimeStructure: null,
      attachments: [{
        filename: "private.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        disposition: "attachment",
        contentId: "<private-part@example.test>",
        partNumber: "2"
      }]
    };
    const readableRepository = new MirrorRepository(pool, getConfig());
    const [readableMessage] = await readableRepository.upsertMessages(
      accountId,
      folder,
      1,
      [metadata],
      new Date("2025-01-01T00:00:00.000Z")
    );
    const readableStoredMessage = await pool.query<{
      rfc_message_id: string | null;
      in_reply_to: string | null;
      references_header: string | null;
    }>(
      `SELECT rfc_message_id, in_reply_to, references_header
       FROM public.imap_messages WHERE id = $1`,
      [readableMessage.id]
    );
    expect(readableStoredMessage.rows[0]).toEqual({
      rfc_message_id: metadata.rfcMessageId,
      in_reply_to: metadata.inReplyTo,
      references_header: metadata.referencesHeader
    });

    const repository = new MirrorRepository(pool, getConfig(), new OpaqueTestAdapter());
    const [message] = await repository.upsertMessages(
      accountId,
      folder,
      1,
      [metadata],
      new Date("2025-01-01T00:00:00.000Z")
    );
    expect(message.id).toBe(readableMessage.id);

    expect(message.subject).toBe(metadata.subject);
    await expect(repository.getMessage(message.id)).resolves.toMatchObject({
      subject: metadata.subject,
      from_email: metadata.fromEmail
    });

    const storedMessage = await pool.query<{
      subject: string | null;
      from_email: string | null;
      rfc_message_id: string | null;
      in_reply_to: string | null;
      references_header: string | null;
      protected_metadata: Buffer | null;
    }>(
      `SELECT subject, from_email, rfc_message_id, in_reply_to,
              references_header, protected_metadata
       FROM public.imap_messages WHERE id = $1`,
      [message.id]
    );
    expect(storedMessage.rows[0]).toMatchObject({
      subject: null,
      from_email: null,
      rfc_message_id: null,
      in_reply_to: null,
      references_header: null
    });
    expect(storedMessage.rows[0].protected_metadata).toBeInstanceOf(Buffer);

    const storedAttachment = await pool.query<{
      filename: string | null;
      content_id: string | null;
      protected_metadata: Buffer | null;
    }>(
      `SELECT filename, content_id, protected_metadata
       FROM public.imap_attachments WHERE message_id = $1`,
      [message.id]
    );
    expect(storedAttachment.rows[0]).toMatchObject({
      filename: null,
      content_id: null
    });
    expect(storedAttachment.rows[0].protected_metadata).toBeInstanceOf(Buffer);

    await repository.storeBodyEvidence({
      messageId: message.id,
      rawMime: Buffer.from("Message-ID: <protected@example.test>\r\n\r\nprivate body"),
      rawBytes: 57,
      rawTruncated: false,
      bodyText: "private body",
      bodyHtml: null,
      bodyPlain: "private body",
      selectedTextPart: "private body",
      selectedTextFormat: "plain",
      headersJson: { "message-id": "<protected@example.test>" },
      mimeStructure: null,
      parserWarnings: ["private warning"],
      evidence: [{
        kind: "calendar_instance",
        namespace: "ical",
        key: "private-calendar-id",
        metadata: { summary: "Private event" }
      }]
    });

    const storedBody = await pool.query<{
      search_extract: string | null;
      headers_json: Record<string, unknown> | null;
      protected_metadata: Buffer | null;
    }>(
      `SELECT search_extract, headers_json, protected_metadata
       FROM public.imap_message_bodies WHERE message_id = $1`,
      [message.id]
    );
    expect(storedBody.rows[0]).toMatchObject({
      search_extract: null,
      headers_json: {}
    });
    expect(storedBody.rows[0].protected_metadata).toBeInstanceOf(Buffer);

    const storedEvidence = await pool.query<{
      evidence_key: string | null;
      metadata: Record<string, unknown> | null;
      protected_metadata: Buffer | null;
    }>(
      `SELECT evidence_key, metadata, protected_metadata
       FROM public.imap_message_evidence WHERE message_id = $1`,
      [message.id]
    );
    expect(storedEvidence.rows).toHaveLength(1);
    expect(storedEvidence.rows[0].evidence_key).toMatch(/^[0-9a-f]{64}$/);
    expect(storedEvidence.rows[0].metadata).toEqual({});
    expect(storedEvidence.rows[0].protected_metadata).toBeInstanceOf(Buffer);

    const partialRevealRepository = new MirrorRepository(
      pool,
      getConfig(),
      new PartialBodyRevealAdapter()
    );
    await expect(partialRevealRepository.storeBodyEvidence({
      messageId: message.id,
      rawMime: Buffer.from("Message-ID: <protected@example.test>\r\n\r\nprivate body"),
      rawBytes: 57,
      rawTruncated: false,
      bodyText: "private body",
      bodyHtml: null,
      bodyPlain: "private body",
      selectedTextPart: "private body",
      selectedTextFormat: "plain",
      headersJson: { "message-id": "<protected@example.test>" },
      mimeStructure: null,
      parserWarnings: ["private warning"],
      evidence: []
    })).rejects.toThrow("must contain every requested field");

    await repository.upsertMessages(
      accountId,
      folder,
      1,
      [metadata],
      new Date("2025-01-01T00:00:00.000Z")
    );
    await expect(repository.getMessage(message.id)).resolves.toMatchObject({
      rfc_message_id: metadata.rfcMessageId,
      message_id_normalized: metadata.messageIdNormalized
    });
  });
});
