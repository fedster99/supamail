import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getConfig } from "../config.js";
import { closePool, getPool } from "../db.js";
import { runDraftReply } from "../mcp/tools/draft-reply.js";
import { MirrorRepository } from "../repository.js";
import type { ImapFolder, MessageMetadata } from "../types.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

liveDb("threading-header ingestion", () => {
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

  it("keeps full-body reply headers when a later metadata scan is incomplete", async () => {
    const email = `thread-headers-${randomUUID()}@example.test`;
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
      rfcMessageId: null,
      messageIdNormalized: null,
      providerMessageId: null,
      providerMessageIdNamespace: null,
      providerThreadId: null,
      providerThreadIdNamespace: null,
      inReplyTo: null,
      referencesHeader: null,
      subject: "Recovered reply headers",
      fromEmail: "sender@example.test",
      fromName: "Sender",
      toEmails: [email],
      toNames: [null],
      ccEmails: [],
      ccNames: [],
      bccEmails: [],
      headersJson: {},
      mimeStructure: null,
      attachments: []
    };
    const mirror = new MirrorRepository(pool, getConfig());
    const [stored] = await mirror.upsertMessages(
      accountId,
      folder,
      1,
      [metadata],
      new Date("2025-01-01T00:00:00.000Z")
    );

    const rawMime = Buffer.from(
      "Message-ID: <recovered-source@example.test>\r\n" +
      "In-Reply-To: <ancestor@example.test>\r\n" +
      "References: <ancestor@example.test>\r\n\r\nbody"
    );
    await mirror.storeBody({
      messageId: stored.id,
      rawMime,
      rawBytes: rawMime.byteLength,
      rawTruncated: false,
      bodyText: "body",
      bodyHtml: null,
      bodyPlain: "body",
      selectedTextPart: "body",
      selectedTextFormat: "plain",
      headersJson: {
        "message-id": "<recovered-source@example.test>",
        "in-reply-to": "<ancestor@example.test>",
        references: "<ancestor@example.test>"
      },
      mimeStructure: null,
      parserWarnings: [],
      evidence: [{
        kind: "provider_resource",
        namespace: "github_issue",
        key: "supamail/supamail#42",
        metadata: { provider: "github", number: 42 }
      }]
    });

    const storedEvidence = await pool.query<{
      namespace: string;
      evidence_key: string;
      extractor_version: string;
      complete: boolean;
      digest: string | null;
    }>(
      `SELECT e.namespace, e.evidence_key, e.extractor_version,
              b.structured_evidence_complete AS complete,
              b.structured_evidence_sha256 AS digest
       FROM public.imap_message_evidence e
       JOIN public.imap_message_bodies b ON b.message_id = e.message_id
       WHERE e.message_id = $1`,
      [stored.id]
    );
    expect(storedEvidence.rows).toEqual([expect.objectContaining({
      namespace: "github_issue",
      evidence_key: "supamail/supamail#42",
      extractor_version: "mime_evidence_v1",
      complete: true,
      digest: expect.stringMatching(/^[0-9a-f]{64}$/)
    })]);

    // Flag/reconcile scans can observe the same incomplete metadata again.
    await mirror.upsertMessages(
      accountId,
      folder,
      1,
      [metadata],
      new Date("2025-01-01T00:00:00.000Z")
    );

    const draft = await runDraftReply(pool, {
      source_message_id: stored.id,
      body: "Reply"
    });
    expect(draft).not.toHaveProperty("error");
    if ("error" in draft) throw new Error(draft.error.message);
    expect(draft.headers).toMatchObject({
      "In-Reply-To": "<recovered-source@example.test>",
      References: "<ancestor@example.test> <recovered-source@example.test>"
    });
  });
});
