import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { PgPool } from "../db.js";
import {
  MirrorRepository,
  canonicalJsonForThreadingEvidence
} from "../repository.js";
import type { ImapFolder, MessageMetadata } from "../types.js";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const FOLDER_ID = "00000000-0000-4000-8000-000000000002";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000003";
const SURVIVOR_ID = "00000000-0000-4000-8000-000000000004";
const RUN_ID = "00000000-0000-4000-8000-000000000005";
const LIVE_STATUSES = ["building", "ready", "active", "standby"];

function sqlText(value: unknown): string {
  const text = typeof value === "object" && value !== null && "text" in value
    ? String((value as { text: unknown }).text)
    : String(value);
  return text.replace(/\s+/g, " ").trim();
}

function sqlParams(value: unknown, params: unknown[]): unknown[] {
  return typeof value === "object" && value !== null && "values" in value
    ? ((value as { values?: unknown[] }).values ?? [])
    : params;
}

function repositoryWithClient(
  client: {
    query(sql: unknown, params?: unknown[]): Promise<unknown>;
    release(): void;
  },
  config: Partial<AppConfig> = {}
) {
  const pool = { connect: vi.fn(async () => client) } as unknown as PgPool;
  return new MirrorRepository(pool, { BODY_STORAGE_MODE: "raw_mime", ...config } as AppConfig);
}

const folder = {
  id: FOLDER_ID,
  account_id: ACCOUNT_ID,
  path: "INBOX"
} as ImapFolder;

const metadata: MessageMetadata = {
  uid: 42,
  internalDate: new Date("2026-01-02T03:04:05.000Z"),
  sizeBytes: 123,
  flags: ["\\Seen"],
  rfcMessageId: "<new@example.test>",
  messageIdNormalized: "new@example.test",
  providerMessageId: "opaque-message",
  providerMessageIdNamespace: "gmail",
  providerThreadId: "opaque-thread",
  providerThreadIdNamespace: "gmail",
  inReplyTo: null,
  referencesHeader: null,
  subject: "A new message",
  fromEmail: "sender@example.test",
  fromName: "Sender",
  toEmails: ["recipient@example.test"],
  toNames: ["Recipient"],
  ccEmails: [],
  ccNames: [],
  bccEmails: [],
  headersJson: { "x-z": "last", "x-a": "first" },
  mimeStructure: null,
  attachments: []
};

describe("repository threading evidence wiring", () => {
  it("canonicalizes JSONB objects without changing array semantics", () => {
    const left = { z: 1, nested: { b: true, a: [1, 2] }, omitted: undefined };
    const right = { nested: { a: [1, 2], b: true }, z: 1 };
    expect(canonicalJsonForThreadingEvidence(left)).toBe(canonicalJsonForThreadingEvidence(right));
    expect(canonicalJsonForThreadingEvidence([1, 2])).not.toBe(canonicalJsonForThreadingEvidence([2, 1]));
  });

  it("writes provider evidence behind the threading state barrier", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: unknown, params: unknown[] = []) => {
        const text = sqlText(sql);
        const values = sqlParams(sql, params);
        calls.push({ sql: text, params: values });
        if (text.includes("FROM public.imap_thread_state") && text.includes("FOR SHARE")) {
          return { rows: [{ account_id: ACCOUNT_ID }], rowCount: 1 };
        }
        if (text.startsWith("SELECT id") && text.includes("FROM public.imap_folders")) {
          return { rows: [{ id: FOLDER_ID, uidvalidity: "7" }], rowCount: 1 };
        }
        if (text.startsWith("SELECT uid::text AS uid")) return { rows: [], rowCount: 0 };
        if (text.includes("INSERT INTO public.imap_messages")) {
          return { rows: [{ id: MESSAGE_ID, uid: "42" }], rowCount: 1 };
        }
        if (text.includes("UPDATE public.imap_folders")) {
          return { rows: [{ id: FOLDER_ID }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      })
    };
    const repository = repositoryWithClient(client);

    await repository.upsertMessages(
      ACCOUNT_ID,
      folder,
      7,
      [metadata],
      new Date("2025-01-01T00:00:00.000Z")
    );

    const stateLockIndex = calls.findIndex((call) => call.sql.includes("FOR SHARE"));
    const messageWriteIndex = calls.findIndex((call) => call.sql.includes("INSERT INTO public.imap_messages"));
    expect(stateLockIndex).toBeGreaterThan(-1);
    expect(stateLockIndex).toBeLessThan(messageWriteIndex);

    const messageWrite = calls[messageWriteIndex];
    expect(messageWrite?.sql).toContain("provider_message_id_namespace");
    expect(messageWrite?.sql).toContain("provider_thread_id_namespace");
    expect(JSON.parse(String(messageWrite?.params[0]))).toMatchObject([{
      provider_message_id: "opaque-message",
      provider_message_id_namespace: "gmail",
      provider_thread_id: "opaque-thread",
      provider_thread_id_namespace: "gmail"
    }]);
  });

  it("does not requeue an unchanged body when JSONB key order changes", async () => {
    const rawMime = Buffer.from("Message-ID: <new@example.test>\r\n\r\nbody");
    const rawHash = createHash("sha256").update(rawMime).digest("hex");
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: unknown, params: unknown[] = []) => {
        const text = sqlText(sql);
        calls.push({ sql: text, params });
        if (text === "SELECT account_id FROM public.imap_messages WHERE id = $1") {
          return { rows: [{ account_id: ACCOUNT_ID }], rowCount: 1 };
        }
        if (text.includes("FROM public.imap_thread_state") && text.includes("FOR SHARE")) {
          return { rows: [{ account_id: ACCOUNT_ID }], rowCount: 1 };
        }
        if (text.includes("LEFT JOIN public.imap_message_bodies")) {
          return {
            rows: [{
              account_id: ACCOUNT_ID,
              folder_path: "INBOX",
              body_fetched_at: new Date("2026-01-01T00:00:00.000Z"),
              rfc_message_id: "<new@example.test>",
              in_reply_to: null,
              references_header: null,
              headers_json: {},
              raw_mime_sha256: rawHash,
              body_headers_json: { "x-z": "last", "x-a": "first" }
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      })
    };
    const repository = repositoryWithClient(client);

    await repository.storeBody({
      messageId: MESSAGE_ID,
      rawMime,
      rawBytes: rawMime.byteLength,
      rawTruncated: false,
      bodyText: "body",
      bodyHtml: null,
      bodyPlain: "body",
      selectedTextPart: "body",
      selectedTextFormat: "plain",
      headersJson: { "x-a": "first", "x-z": "last" },
      mimeStructure: null,
      parserWarnings: [],
      evidence: []
    });

    expect(calls.some((call) => call.sql.startsWith("INSERT INTO public.imap_thread_work_queue"))).toBe(false);
    const stateLockIndex = calls.findIndex((call) => call.sql.includes("FOR SHARE"));
    const bodyWriteIndex = calls.findIndex((call) => call.sql.startsWith("INSERT INTO public.imap_message_bodies"));
    expect(stateLockIndex).toBeLessThan(bodyWriteIndex);
    expect(calls[bodyWriteIndex]?.sql).toContain("parsed_delivery_sha256 = NULL");
    expect(calls[bodyWriteIndex]?.sql).toContain("authored_delivery_sha256 = NULL");
  });

  it("atomically replaces structured message evidence on body recomputation", async () => {
    const rawMime = Buffer.from("Message-ID: <evidence@example.test>\r\n\r\nbody");
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: unknown, params: unknown[] = []) => {
        const text = sqlText(sql);
        const values = sqlParams(sql, params);
        calls.push({ sql: text, params: values });
        if (text === "SELECT account_id FROM public.imap_messages WHERE id = $1") {
          return { rows: [{ account_id: ACCOUNT_ID }], rowCount: 1 };
        }
        if (text.includes("FROM public.imap_thread_state") && text.includes("FOR SHARE")) {
          return { rows: [{ account_id: ACCOUNT_ID }], rowCount: 1 };
        }
        if (text.includes("LEFT JOIN public.imap_message_bodies")) {
          return {
            rows: [{
              account_id: ACCOUNT_ID,
              folder_path: "INBOX",
              body_fetched_at: new Date("2026-01-01T00:00:00.000Z"),
              rfc_message_id: "<evidence@example.test>",
              in_reply_to: null,
              references_header: null,
              headers_json: {},
              raw_mime_sha256: null,
              body_headers_json: {}
            }],
            rowCount: 1
          };
        }
        if (text.startsWith("INSERT INTO public.imap_message_evidence")) {
          return { rows: [{ id: "evidence-row" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      })
    };
    const repository = repositoryWithClient(client);

    await repository.storeBody({
      messageId: MESSAGE_ID,
      rawMime,
      rawBytes: rawMime.byteLength,
      rawTruncated: false,
      bodyText: "body",
      bodyHtml: null,
      bodyPlain: "body",
      selectedTextPart: "body",
      selectedTextFormat: "plain",
      headersJson: {},
      mimeStructure: null,
      parserWarnings: [],
      evidence: [{
        kind: "provider_resource",
        namespace: "github_issue",
        key: "acme/mail#42",
        metadata: { provider: "github", number: 42 }
      }]
    });

    const deleteIndex = calls.findIndex((call) => call.sql.startsWith("DELETE FROM public.imap_message_evidence"));
    const insertIndex = calls.findIndex((call) => call.sql.startsWith("INSERT INTO public.imap_message_evidence"));
    const commitIndex = calls.findIndex((call) => call.sql === "COMMIT");
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeLessThan(deleteIndex);
    expect(deleteIndex).toBeLessThan(commitIndex);

    const inserted = JSON.parse(String(calls[insertIndex]?.params[0]));
    expect(inserted).toEqual([expect.objectContaining({
      message_id: MESSAGE_ID,
      kind: "provider_resource",
      namespace: "github_issue",
      evidence_key: "acme/mail#42",
      evidence_key_sha256: createHash("sha256").update("acme/mail#42").digest("hex"),
      extractor_version: "mime_evidence_v1"
    })]);

    await repository.storeBody({
      messageId: MESSAGE_ID,
      rawMime,
      rawBytes: rawMime.byteLength,
      rawTruncated: false,
      bodyText: "body",
      bodyHtml: null,
      bodyPlain: "body",
      selectedTextPart: "body",
      selectedTextFormat: "plain",
      headersJson: {},
      mimeStructure: null,
      parserWarnings: ["artifact_evidence_truncated"],
      evidence: []
    });
    const finalBodyWrite = calls
      .filter((call) => call.sql.startsWith("INSERT INTO public.imap_message_bodies"))
      .at(-1);
    expect(finalBodyWrite?.params.slice(13, 16)).toEqual([
      "mime_evidence_v1",
      null,
      false
    ]);
  });

  it("requeues every live run when a complete body fingerprint changes", async () => {
    const rawMime = Buffer.from("Message-ID: <new@example.test>\r\n\r\nnew body");
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: unknown, params: unknown[] = []) => {
        const text = sqlText(sql);
        calls.push({ sql: text, params });
        if (text === "SELECT account_id FROM public.imap_messages WHERE id = $1") {
          return { rows: [{ account_id: ACCOUNT_ID }], rowCount: 1 };
        }
        if (text.includes("FROM public.imap_thread_state") && text.includes("FOR SHARE")) {
          return { rows: [{ account_id: ACCOUNT_ID }], rowCount: 1 };
        }
        if (text.includes("LEFT JOIN public.imap_message_bodies")) {
          return {
            rows: [{
              account_id: ACCOUNT_ID,
              folder_path: "INBOX",
              body_fetched_at: new Date("2026-01-01T00:00:00.000Z"),
              rfc_message_id: "<new@example.test>",
              in_reply_to: null,
              references_header: null,
              headers_json: {},
              raw_mime_sha256: "0".repeat(64),
              body_headers_json: {}
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      })
    };
    const repository = repositoryWithClient(client);

    await repository.storeBody({
      messageId: MESSAGE_ID,
      rawMime,
      rawBytes: rawMime.byteLength,
      rawTruncated: false,
      bodyText: "new body",
      bodyHtml: null,
      bodyPlain: "new body",
      selectedTextPart: "new body",
      selectedTextFormat: "plain",
      headersJson: {},
      mimeStructure: null,
      parserWarnings: [],
      evidence: []
    });

    const queue = calls.find((call) => call.sql.startsWith("INSERT INTO public.imap_thread_work_queue"));
    expect(queue?.params).toEqual([
      ACCOUNT_ID,
      [MESSAGE_ID],
      "body_fingerprint_changed",
      LIVE_STATUSES
    ]);
  });

  it("queues survivors and subject buckets before a bounded purge delete", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: unknown, params: unknown[] = []) => {
        const text = sqlText(sql);
        calls.push({ sql: text, params });
        if (text.startsWith("SELECT id, account_id FROM public.imap_messages") && text.includes("LIMIT $1")) {
          return { rows: [{ id: MESSAGE_ID, account_id: ACCOUNT_ID }], rowCount: 1 };
        }
        if (text.includes("FOR UPDATE SKIP LOCKED")) {
          return { rows: [{ id: MESSAGE_ID, account_id: ACCOUNT_ID }], rowCount: 1 };
        }
        if (text.startsWith("WITH affected_components AS")) {
          return {
            rows: [{ run_id: RUN_ID, message_id: SURVIVOR_ID, account_id: ACCOUNT_ID }],
            rowCount: 1
          };
        }
        if (text.startsWith("DELETE FROM public.imap_messages")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      })
    };
    const repository = repositoryWithClient(client);

    await expect(repository.runPurgeJob()).resolves.toEqual({ purged: 1 });

    const stateLockIndex = calls.findIndex((call) => call.sql.includes("FROM public.imap_thread_state") && call.sql.includes("FOR SHARE"));
    const rowLockIndex = calls.findIndex((call) => call.sql.includes("FOR UPDATE SKIP LOCKED"));
    const queueIndex = calls.findIndex((call) => call.sql.startsWith("INSERT INTO public.imap_thread_work_queue"));
    const subjectIndex = calls.findIndex((call) => call.sql.startsWith("WITH affected_subjects AS"));
    const deleteIndex = calls.findIndex((call) => call.sql.startsWith("DELETE FROM public.imap_messages"));

    expect(stateLockIndex).toBeLessThan(rowLockIndex);
    expect(queueIndex).toBeLessThan(deleteIndex);
    expect(subjectIndex).toBeLessThan(deleteIndex);
    expect(calls[0]?.sql).toBe("BEGIN");
    expect(calls.at(-1)?.sql).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();

    const discovery = calls.find((call) => call.sql.includes("ORDER BY id") && call.sql.includes("LIMIT $1"));
    expect(discovery?.params).toEqual([100]);
    const closure = calls.find((call) => call.sql.startsWith("WITH affected_components AS"));
    expect(closure?.params[3]).toBe(25_001);
    expect(closure?.params[1]).toEqual(LIVE_STATUSES);
  });
});
