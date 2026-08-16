import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getConfig } from "../config.js";
import { closePool, createPool, getPool } from "../db.js";
import type {
  MetadataProtectionAdapter,
  MetadataProtectionContext,
  MetadataProtectionOperationOptions,
  MetadataProtectionProjection,
  MetadataValues
} from "../metadata-protection.js";
import { protectedMetadataColumns } from "../metadata-protection.js";
import { MirrorRepository } from "../repository.js";
import {
  ThreadingClosureLimitError,
  ThreadingEvidenceLimitError,
  ThreadingRepository,
  ThreadingVersionSkewError,
  isThreadingStatementTimeout,
  type ThreadingRunResult
} from "../threading-repository.js";
import {
  computeThreadAssignments,
  computeThreadAssignmentsV1,
  computeThreadAssignmentsV2,
  deliveryClosureFingerprints
} from "../threading.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

class OpaqueThreadingAdapter implements MetadataProtectionAdapter {
  readonly writes: Array<{ context: MetadataProtectionContext; values: MetadataValues }> = [];

  #projectAssignment(values: MetadataValues): MetadataValues {
    const readableFields = new Set([
      "run_id",
      "message_id",
      "account_id",
      "assignment_method",
      "confidence",
      "is_provisional",
      "subject_fallback_eligible",
      "algorithm_version",
      "generation"
    ]);
    return Object.fromEntries(
      Object.entries(values).map(([field, value]) => {
        if (readableFields.has(field) || value === null) return [field, value];
        if (Array.isArray(value)) {
          return [field, value.map((entry) => createHash("sha256").update(String(entry)).digest("hex"))];
        }
        if (field === "evidence") return [field, {}];
        if (field === "conversation_id") {
          return [field, `thread_${createHash("sha256").update(String(value)).digest("hex").slice(0, 32)}`];
        }
        return [field, createHash("sha256").update(JSON.stringify(value)).digest("hex")];
      })
    );
  }

  async protect(
    context: MetadataProtectionContext,
    values: MetadataValues
  ): Promise<MetadataProtectionProjection> {
    this.writes.push({ context, values });
    const projected = context.kind === "thread_assignment_history"
      ? {
          previous_assignment: values.previous_assignment === null
            ? null
            : this.#projectAssignment(values.previous_assignment as MetadataValues),
          next_assignment: values.next_assignment === null
            ? null
            : this.#projectAssignment(values.next_assignment as MetadataValues)
        }
      : context.kind === "message"
        ? Object.fromEntries(Object.entries(values).map(([field, value]) => {
            if (value === null) return [field, null];
            if (field === "headers_json") return [field, {}];
            if (field === "mime_structure") return [field, null];
            if (Array.isArray(value)) return [field, []];
            if (field.endsWith("_namespace")) return [field, value];
            return [field, createHash("sha256").update(JSON.stringify(value)).digest("hex")];
          }))
        : context.kind === "message_body"
          ? Object.fromEntries(Object.entries(values).map(([field, value]) => {
              if (value === null) return [field, null];
              if (field === "headers_json") return [field, {}];
              if (field === "mime_structure" || field === "search_extract") return [field, null];
              if (field === "parser_warnings") return [field, []];
              return [field, createHash("sha256").update(JSON.stringify(value)).digest("hex")];
            }))
        : this.#projectAssignment(values);
    return {
      values: projected,
      protectedMetadata: Buffer.from(JSON.stringify({ context, values })),
      envelopeVersion: 1,
      keyVersion: 1,
      tokens: { test: createHash("sha256").update(JSON.stringify(values)).digest("hex") }
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

class IncompleteThreadAssignmentAdapter extends OpaqueThreadingAdapter {
  override async protect(
    context: MetadataProtectionContext,
    values: MetadataValues
  ): Promise<MetadataProtectionProjection> {
    const projection = await super.protect(context, values);
    if (context.kind === "thread_assignment") delete projection.values.subject_key;
    return projection;
  }
}

class IncompleteThreadHistoryRevealAdapter extends OpaqueThreadingAdapter {
  override async reveal(
    context: MetadataProtectionContext,
    stored: MetadataProtectionProjection
  ): Promise<MetadataValues> {
    const values = await super.reveal(context, stored);
    if (context.kind === "thread_assignment_history") delete values.next_assignment;
    return values;
  }
}

class PageTwoIncompleteThreadHistoryRevealAdapter extends OpaqueThreadingAdapter {
  historyReveals = 0;

  override async reveal(
    context: MetadataProtectionContext,
    stored: MetadataProtectionProjection
  ): Promise<MetadataValues> {
    const values = await super.reveal(context, stored);
    if (context.kind !== "thread_assignment_history") return values;
    this.historyReveals += 1;
    if (this.historyReveals > 32) delete values.next_assignment;
    return values;
  }
}

class HangingThreadAssignmentAdapter extends OpaqueThreadingAdapter {
  override async protect(
    context: MetadataProtectionContext,
    values: MetadataValues
  ): Promise<MetadataProtectionProjection> {
    if (context.kind === "thread_assignment") {
      return new Promise<MetadataProtectionProjection>(() => undefined);
    }
    return super.protect(context, values);
  }
}

class NonCooperativeThreadAssignmentAdapter extends OpaqueThreadingAdapter {
  active = 0;
  started = 0;

  override async protect(
    context: MetadataProtectionContext,
    values: MetadataValues
  ): Promise<MetadataProtectionProjection> {
    if (context.kind !== "thread_assignment") return super.protect(context, values);
    this.active += 1;
    this.started += 1;
    return new Promise<MetadataProtectionProjection>(() => undefined);
  }
}

class LargeThreadAssignmentEnvelopeAdapter extends OpaqueThreadingAdapter {
  override async protect(
    context: MetadataProtectionContext,
    values: MetadataValues
  ): Promise<MetadataProtectionProjection> {
    const projection = await super.protect(context, values);
    if (context.kind !== "thread_assignment" || !projection.protectedMetadata) return projection;
    const envelope = JSON.parse(projection.protectedMetadata.toString("utf8")) as Record<string, unknown>;
    return {
      ...projection,
      protectedMetadata: Buffer.from(JSON.stringify({
        ...envelope,
        padding: "x".repeat(400_000)
      }))
    };
  }
}

class SlowThreadAssignmentAdapter extends OpaqueThreadingAdapter {
  active = 0;
  maxActive = 0;

  override async protect(
    context: MetadataProtectionContext,
    values: MetadataValues,
    options?: MetadataProtectionOperationOptions
  ): Promise<MetadataProtectionProjection> {
    if (context.kind !== "thread_assignment") return super.protect(context, values);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise<void>((resolve, reject) => {
        const signal = options?.signal;
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 30);
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      return await super.protect(context, values);
    } finally {
      this.active -= 1;
    }
  }
}

interface SeedMessage {
  uid: number;
  folder?: string;
  uidvalidity?: number;
  internalDate?: string;
  subject?: string | null;
  fromEmail?: string | null;
  toEmails?: string[];
  ccEmails?: string[];
  rfcMessageId?: string | null;
  inReplyTo?: string | null;
  referencesHeader?: string | null;
  providerMessageId?: string | null;
  providerMessageNamespace?: string | null;
  providerThreadId?: string | null;
  providerThreadNamespace?: string | null;
  rawMime?: Buffer;
  rawTruncated?: boolean;
  rawMimeSha256?: string | null;
  headersJson?: Record<string, unknown>;
}

interface ProjectionRow {
  uid: string;
  run_id: string;
  delivery_key: string;
  conversation_id: string;
  root_reference: string | null;
  parent_reference: string | null;
  assignment_method: string;
  confidence: string;
  is_provisional: boolean;
  subject_fallback_eligible: boolean;
  generation: string;
  evidence: Record<string, unknown>;
}

liveDb("ThreadingRepository live DB", () => {
  let pool: ReturnType<typeof getPool>;
  let repository: ThreadingRepository;
  let mirror: MirrorRepository;
  const accountIds = new Set<string>();

  async function createAccount(label: string): Promise<string> {
    const email = `threading-${label}-${randomUUID()}@example.test`;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO public.imap_accounts (
         email_address, host, port, username, encrypted_password
       ) VALUES ($1, 'imap.example.test', 993, $1, $2)
       RETURNING id`,
      [email, Buffer.from([0])]
    );
    const accountId = result.rows[0].id;
    accountIds.add(accountId);
    return accountId;
  }

  async function markMetadataProtected(accountId: string): Promise<void> {
    await pool.query(
      "UPDATE public.imap_accounts SET metadata_protection_mode = 'protected' WHERE id = $1",
      [accountId]
    );
  }

  async function seedMessage(accountId: string, message: SeedMessage): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO public.imap_messages (
         account_id, folder_path, uidvalidity, uid, internal_date,
         subject, from_email, to_emails, cc_emails,
         rfc_message_id, message_id_normalized,
         in_reply_to, references_header,
         provider_message_id, provider_message_id_namespace,
         provider_thread_id, provider_thread_id_namespace,
         window_status, size_bytes, headers_json
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11,
         $12, $13,
         $14, $15,
         $16, $17,
         'IN_WINDOW', $18, $19::jsonb
       ) RETURNING id`,
      [
        accountId,
        message.folder ?? "INBOX",
        message.uidvalidity ?? 101,
        message.uid,
        message.internalDate ?? `2026-01-${String(Math.min(message.uid, 28)).padStart(2, "0")}T12:00:00.000Z`,
        message.subject ?? null,
        message.fromEmail ?? null,
        message.toEmails ?? [],
        message.ccEmails ?? [],
        message.rfcMessageId ?? null,
        message.rfcMessageId?.replace(/^<|>$/g, "") ?? null,
        message.inReplyTo ?? null,
        message.referencesHeader ?? null,
        message.providerMessageId ?? null,
        message.providerMessageNamespace ?? null,
        message.providerThreadId ?? null,
        message.providerThreadNamespace ?? null,
        message.rawMime?.byteLength ?? 0,
        JSON.stringify(message.headersJson ?? {})
      ]
    );
    const id = result.rows[0].id;

    if (message.rawMime) {
      await pool.query(
        `INSERT INTO public.imap_message_bodies (
           message_id, raw_mime, raw_mime_sha256, raw_bytes,
           raw_truncated, headers_json
         ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)`,
        [
          id,
          message.rawMime,
          message.rawMimeSha256 === undefined
            ? createHash("sha256").update(message.rawMime).digest("hex")
            : message.rawMimeSha256,
          message.rawMime.byteLength,
          message.rawTruncated ?? false
        ]
      );
      await pool.query("UPDATE public.imap_messages SET body_fetched_at = now() WHERE id = $1", [id]);
    }
    return id;
  }

  async function protectMessageInput(
    adapter: MetadataProtectionAdapter,
    accountId: string,
    messageId: string
  ): Promise<void> {
    const fields = [
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
    ] as const;
    const stored = await pool.query<Record<string, unknown>>(
      `SELECT ${fields.join(", ")} FROM public.imap_messages WHERE id = $1`,
      [messageId]
    );
    const values = Object.fromEntries(fields.map((field) => [field, stored.rows[0]?.[field]]));
    const projection = await adapter.protect(
      { kind: "message", accountId, recordId: messageId },
      values
    );
    const columns = protectedMetadataColumns(projection);
    await pool.query(
      `UPDATE public.imap_messages SET
         rfc_message_id = value.rfc_message_id,
         message_id_normalized = value.message_id_normalized,
         provider_message_id = value.provider_message_id,
         provider_message_id_namespace = value.provider_message_id_namespace,
         provider_thread_id = value.provider_thread_id,
         provider_thread_id_namespace = value.provider_thread_id_namespace,
         in_reply_to = value.in_reply_to,
         references_header = value.references_header,
         subject = value.subject,
         from_email = value.from_email,
         from_name = value.from_name,
         to_emails = value.to_emails,
         to_names = value.to_names,
         cc_emails = value.cc_emails,
         cc_names = value.cc_names,
         bcc_emails = value.bcc_emails,
         headers_json = value.headers_json,
         mime_structure = value.mime_structure,
         protected_metadata = CASE
           WHEN value.protected_metadata_base64 IS NULL THEN NULL
           ELSE decode(value.protected_metadata_base64, 'base64')
         END,
         protected_metadata_version = value.protected_metadata_version,
         protected_metadata_key_version = value.protected_metadata_key_version,
         protected_metadata_tokens = value.protected_metadata_tokens
       FROM jsonb_to_record($2::jsonb) AS value(
         rfc_message_id text,
         message_id_normalized text,
         provider_message_id text,
         provider_message_id_namespace text,
         provider_thread_id text,
         provider_thread_id_namespace text,
         in_reply_to text,
         references_header text,
         subject text,
         from_email text,
         from_name text,
         to_emails text[],
         to_names text[],
         cc_emails text[],
         cc_names text[],
         bcc_emails text[],
         headers_json jsonb,
         mime_structure jsonb,
         protected_metadata_base64 text,
         protected_metadata_version smallint,
         protected_metadata_key_version integer,
         protected_metadata_tokens jsonb
       )
       WHERE id = $1`,
      [messageId, JSON.stringify({
        ...projection.values,
        protected_metadata_base64: columns.protected_metadata?.toString("base64") ?? null,
        protected_metadata_version: columns.protected_metadata_version,
        protected_metadata_key_version: columns.protected_metadata_key_version,
        protected_metadata_tokens: columns.protected_metadata_tokens
      })]
    );
    await markMetadataProtected(accountId);
  }

  async function protectBodyInput(
    adapter: MetadataProtectionAdapter,
    accountId: string,
    messageId: string
  ): Promise<void> {
    const fields = [
      "raw_mime_sha256",
      "parsed_delivery_sha256",
      "authored_delivery_sha256",
      "headers_json",
      "mime_structure",
      "parser_warnings",
      "structured_evidence_sha256",
      "threading_payload_sha256",
      "search_extract"
    ] as const;
    const stored = await pool.query<Record<string, unknown>>(
      `SELECT ${fields.join(", ")} FROM public.imap_message_bodies WHERE message_id = $1`,
      [messageId]
    );
    const values = Object.fromEntries(fields.map((field) => [field, stored.rows[0]?.[field]]));
    const projection = await adapter.protect(
      { kind: "message_body", accountId, recordId: messageId },
      values
    );
    const columns = protectedMetadataColumns(projection);
    await pool.query(
      `UPDATE public.imap_message_bodies SET
         raw_mime_sha256 = value.raw_mime_sha256,
         parsed_delivery_sha256 = value.parsed_delivery_sha256,
         authored_delivery_sha256 = value.authored_delivery_sha256,
         headers_json = value.headers_json,
         mime_structure = value.mime_structure,
         parser_warnings = value.parser_warnings,
         structured_evidence_sha256 = value.structured_evidence_sha256,
         threading_payload_sha256 = value.threading_payload_sha256,
         search_extract = value.search_extract,
         protected_metadata = CASE
           WHEN value.protected_metadata_base64 IS NULL THEN NULL
           ELSE decode(value.protected_metadata_base64, 'base64')
         END,
         protected_metadata_version = value.protected_metadata_version,
         protected_metadata_key_version = value.protected_metadata_key_version,
         protected_metadata_tokens = value.protected_metadata_tokens
       FROM jsonb_to_record($2::jsonb) AS value(
         raw_mime_sha256 text,
         parsed_delivery_sha256 text,
         authored_delivery_sha256 text,
         headers_json jsonb,
         mime_structure jsonb,
         parser_warnings text[],
         structured_evidence_sha256 text,
         threading_payload_sha256 text,
         search_extract text,
         protected_metadata_base64 text,
         protected_metadata_version smallint,
         protected_metadata_key_version integer,
         protected_metadata_tokens jsonb
       )
       WHERE message_id = $1`,
      [messageId, JSON.stringify({
        ...projection.values,
        protected_metadata_base64: columns.protected_metadata?.toString("base64") ?? null,
        protected_metadata_version: columns.protected_metadata_version,
        protected_metadata_key_version: columns.protected_metadata_key_version,
        protected_metadata_tokens: columns.protected_metadata_tokens
      })]
    );
  }

  async function drainUntilReady(
    accountId: string,
    options: {
      batchSize?: number;
      maxSubjectBucketMessages?: number;
      maxClosureEvidenceBytes?: number;
    } = {},
    target: ThreadingRepository = repository
  ): Promise<ThreadingRunResult> {
    let last: ThreadingRunResult | null = null;
    for (let pass = 0; pass < 200; pass += 1) {
      last = await target.drainAccount(accountId, { ...options, requestedBy: "live-test" });
      if (last.ready && last.runStatus === "ready") return last;
    }
    throw new Error(`threading run did not become ready: ${JSON.stringify(last)}`);
  }

  async function projection(runId: string): Promise<ProjectionRow[]> {
    const result = await pool.query<ProjectionRow>(
      `SELECT m.uid::text AS uid, a.run_id, a.delivery_key, a.conversation_id,
              a.root_reference, a.parent_reference, a.assignment_method,
              a.confidence, a.is_provisional, a.subject_fallback_eligible,
              a.generation::text, a.evidence
       FROM public.imap_thread_assignments a
       JOIN public.imap_messages m ON m.id = a.message_id
       WHERE a.run_id = $1
       ORDER BY m.uid, m.folder_path, m.id`,
      [runId]
    );
    return result.rows;
  }

  async function activeProjection(accountId: string): Promise<ProjectionRow[]> {
    const result = await pool.query<ProjectionRow>(
      `SELECT m.uid::text AS uid, a.run_id, a.delivery_key, a.conversation_id,
              a.root_reference, a.parent_reference, a.assignment_method,
              a.confidence, a.is_provisional, a.subject_fallback_eligible,
              a.generation::text, a.evidence
       FROM public.imap_thread_active_assignments a
       JOIN public.imap_messages m ON m.id = a.message_id
       WHERE a.account_id = $1
       ORDER BY m.uid, m.folder_path, m.id`,
      [accountId]
    );
    return result.rows;
  }

  async function enqueueMessage(accountId: string, messageId: string, reason = "live_test_change"): Promise<void> {
    await pool.query(
      `INSERT INTO public.imap_thread_work_queue (run_id, message_id, account_id, reason)
       SELECT run.id, $2, $1, $3
       FROM public.imap_thread_runs run
       WHERE run.account_id = $1
         AND run.status IN ('building', 'ready', 'active', 'standby')
       ON CONFLICT (run_id, message_id) DO UPDATE SET
         reason = EXCLUDED.reason,
         attempts = 0,
         available_at = now(),
         last_error = NULL,
         enqueued_at = now(),
         updated_at = now()`,
      [accountId, messageId, reason]
    );
  }

  async function drainUntilIdle(accountId: string): Promise<ThreadingRunResult[]> {
    const results: ThreadingRunResult[] = [];
    for (let pass = 0; pass < 100; pass += 1) {
      const pending = await pool.query<{ count: string }>(
        `SELECT (
           (SELECT count(*) FROM public.imap_thread_work_queue WHERE account_id = $1)
           + (SELECT count(*) FROM public.imap_thread_subject_work WHERE account_id = $1)
         )::text AS count`,
        [accountId]
      );
      if (pending.rows[0]?.count === "0") return results;
      results.push(await repository.drainAccount(accountId, { batchSize: 2, requestedBy: "live-test" }));
    }
    throw new Error(`threading work did not drain for ${accountId}`);
  }

  async function drainRepositoryUntilIdle(
    target: ThreadingRepository,
    accountId: string,
    options: { batchSize?: number; maxSubjectBucketMessages?: number } = {}
  ): Promise<ThreadingRunResult[]> {
    const results: ThreadingRunResult[] = [];
    for (let pass = 0; pass < 200; pass += 1) {
      const pending = await pool.query<{ count: string }>(
        `SELECT (
           (SELECT count(*) FROM public.imap_thread_work_queue WHERE account_id = $1)
           + (SELECT count(*) FROM public.imap_thread_subject_work WHERE account_id = $1)
         )::text AS count`,
        [accountId]
      );
      if (pending.rows[0]?.count === "0") return results;
      results.push(await target.drainAccount(accountId, {
        ...options,
        requestedBy: "live-test"
      }));
    }
    throw new Error(`threading work did not drain for ${accountId}`);
  }

  function executorFor(version: number) {
    if (version === 1) return computeThreadAssignmentsV1;
    if (version === 2) return computeThreadAssignmentsV2;
    if (version === 3) return computeThreadAssignments;
    throw new Error(`missing test threading executor v${version}`);
  }

  async function activateReviewed(
    target: ThreadingRepository,
    accountId: string,
    runId: string,
    requestedBy = "live-test",
    reason?: string
  ): Promise<ThreadingRunResult> {
    const state = await pool.query<{ active_run_id: string | null }>(
      "SELECT active_run_id FROM public.imap_thread_state WHERE account_id = $1",
      [accountId]
    );
    const activeRunId = state.rows[0]?.active_run_id ?? null;
    const comparisonId = activeRunId
      ? (await target.compareRuns(accountId, activeRunId, runId, 10, { requestedBy })).comparisonId
      : undefined;
    return target.activateRun(accountId, runId, { requestedBy, reason, comparisonId });
  }

  beforeAll(() => {
    pool = getPool();
    repository = new ThreadingRepository(pool);
    mirror = new MirrorRepository(pool, getConfig());
  });

  afterEach(async () => {
    if (accountIds.size === 0) return;
    await pool.query("DELETE FROM public.imap_accounts WHERE id = ANY($1::uuid[])", [[...accountIds]]);
    accountIds.clear();
  });

  afterAll(async () => {
    await closePool();
  });

  it("builds deterministically in bounded shadow batches and switches every reader atomically", async () => {
    const accountId = await createAccount("shadow-activation");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Quarterly plan",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<root@example.test>"
    });
    await seedMessage(accountId, {
      uid: 2,
      subject: "Re: Quarterly plan",
      fromEmail: "bob@example.test",
      toEmails: ["alice@example.test"],
      rfcMessageId: "<reply-1@example.test>",
      inReplyTo: "<root@example.test>",
      referencesHeader: "<root@example.test>"
    });
    await seedMessage(accountId, {
      uid: 3,
      subject: "Re: Quarterly plan",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<reply-2@example.test>",
      inReplyTo: "<reply-1@example.test>",
      referencesHeader: "<root@example.test> <reply-1@example.test>"
    });

    const ready = await drainUntilReady(accountId, { batchSize: 1 });
    expect(ready).toMatchObject({ runStatus: "ready", stage: "ready", ready: true, active: false });
    expect(await activeProjection(accountId)).toEqual([]);

    const shadow = await projection(ready.runId as string);
    expect(shadow).toHaveLength(3);
    expect(new Set(shadow.map((row) => row.conversation_id)).size).toBe(1);
    expect(shadow.map((row) => row.parent_reference)).toEqual([
      null,
      "root@example.test",
      "reply-1@example.test"
    ]);

    const activated = await activateReviewed(
      repository,
      accountId,
      ready.runId as string,
      "live-test",
      "quality threshold passed"
    );
    expect(activated).toMatchObject({ runStatus: "active", ready: true, active: true });
    expect(await activeProjection(accountId)).toEqual(shadow);
  });

  it("stores threading assignments through the metadata-protection adapter", async () => {
    const accountId = await createAccount("protected-thread-assignment");
    const rawMime = Buffer.from(
      "Message-ID: <protected-thread@example.test>\r\nSubject: Protected thread\r\n\r\nbody"
    );
    const rawMimeHash = createHash("sha256").update(rawMime).digest("hex");
    const messageId = await seedMessage(accountId, {
      uid: 1,
      subject: "Protected thread",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<protected-thread@example.test>",
      rawMime
    });
    const adapter = new OpaqueThreadingAdapter();
    await protectMessageInput(adapter, accountId, messageId);
    await protectBodyInput(adapter, accountId, messageId);
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: adapter
    });

    const result = await drainUntilReady(accountId, {}, protectedRepository);
    const stored = await pool.query<{
      strict_message_id: string | null;
      protected_metadata: Buffer | null;
      protected_metadata_version: number | null;
      protected_metadata_key_version: number | null;
      protected_metadata_tokens: Record<string, string> | null;
    }>(
      `SELECT strict_message_id, protected_metadata,
              protected_metadata_version, protected_metadata_key_version,
              protected_metadata_tokens
       FROM public.imap_thread_assignments
       WHERE run_id = $1 AND message_id = $2`,
      [result.runId, messageId]
    );

    expect(adapter.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        context: {
          kind: "thread_assignment",
          accountId,
          recordId: `${result.runId}:${messageId}`
        },
        values: expect.objectContaining({
          strict_message_id: "protected-thread@example.test",
          delivery_fingerprint_hashes: expect.arrayContaining(
            deliveryClosureFingerprints({
              id: messageId,
              account_id: accountId,
              folder_path: "INBOX",
              uidvalidity: "101",
              uid: "1",
              internal_date: "2026-01-01T12:00:00.000Z",
              size_bytes: rawMime.byteLength,
              raw_mime_hash: rawMimeHash,
              rfc_message_id: "<protected-thread@example.test>",
              subject: "Protected thread",
              from_email: "alice@example.test",
              to_emails: ["bob@example.test"],
              cc_emails: [],
              bcc_emails: [],
              headers_json: {}
            }).map((fingerprint) =>
              createHash("sha256")
                .update(`delivery-fingerprint\u0000${fingerprint}`)
                .digest("hex")
            )
          )
        })
      })
    ]));
    expect(stored.rows[0]?.strict_message_id).not.toBe("protected-thread@example.test");
    expect(stored.rows[0]?.protected_metadata).not.toBeNull();
    expect(stored.rows[0]?.protected_metadata_version).toBe(1);
    expect(stored.rows[0]?.protected_metadata_key_version).toBe(1);
    expect(stored.rows[0]?.protected_metadata_tokens).toHaveProperty("test");

    await enqueueMessage(accountId, messageId);
    const unchanged = await drainRepositoryUntilIdle(protectedRepository, accountId);
    expect(unchanged.every((step) => step.assignmentsChanged === 0)).toBe(true);
  });

  it("blocks a protected adapter until the account migration activates its mode", async () => {
    const accountId = await createAccount("protected-mode-not-active");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Readable projection",
      rfcMessageId: "<readable-projection@example.test>"
    });
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: new OpaqueThreadingAdapter()
    });

    await expect(protectedRepository.drainAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test"
    })).rejects.toThrow(
      "metadata protection mode is plaintext; finish migration before adapter activation"
    );
  });

  it("does not repair body evidence outside the protection adapter", async () => {
    const accountId = await createAccount("protected-body-repair");
    const rawMime = Buffer.from(
      "Message-ID: <protected-repair@example.test>\r\nSubject: Protected repair\r\n\r\nbody"
    );
    const messageId = await seedMessage(accountId, {
      uid: 1,
      subject: "Protected repair",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<protected-repair@example.test>",
      rawMime,
      rawMimeSha256: null
    });
    const adapter = new OpaqueThreadingAdapter();
    await protectMessageInput(adapter, accountId, messageId);
    await protectBodyInput(adapter, accountId, messageId);
    const before = await pool.query<{
      protected_metadata: Buffer;
    }>(
      "SELECT protected_metadata FROM public.imap_message_bodies WHERE message_id = $1",
      [messageId]
    );
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: adapter
    });

    const result = await drainUntilReady(accountId, {}, protectedRepository);
    const after = await pool.query<{
      raw_mime_sha256: string | null;
      protected_metadata: Buffer;
    }>(
      `SELECT raw_mime_sha256, protected_metadata
       FROM public.imap_message_bodies
       WHERE message_id = $1`,
      [messageId]
    );

    expect(result.runStatus).toBe("ready");
    expect(after.rows[0]?.raw_mime_sha256).toBeNull();
    expect(after.rows[0]?.protected_metadata).toEqual(before.rows[0]?.protected_metadata);
  });

  it("measures revealed threading evidence instead of unrelated encrypted fields", async () => {
    const accountId = await createAccount("protected-evidence-limit");
    const messageId = await seedMessage(accountId, {
      uid: 1,
      subject: "Small threading input",
      rfcMessageId: "<small-protected-input@example.test>"
    });
    await pool.query(
      `INSERT INTO public.imap_message_bodies (
         message_id, raw_bytes, raw_truncated, headers_json, search_extract
       ) VALUES ($1, 0, false, '{}'::jsonb, $2)`,
      [messageId, "unrelated".repeat(3_000)]
    );
    const adapter = new OpaqueThreadingAdapter();
    await protectMessageInput(adapter, accountId, messageId);
    await protectBodyInput(adapter, accountId, messageId);
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: adapter
    });

    await expect(drainUntilReady(accountId, {
      batchSize: 1,
      maxClosureEvidenceBytes: 1_024
    }, protectedRepository)).resolves.toMatchObject({
      runStatus: "ready",
      ready: true
    });
  });

  it("counts every variable threading field after a protected reveal", async () => {
    const accountId = await createAccount("protected-variable-evidence-limit");
    const messageId = await seedMessage(accountId, {
      uid: 1,
      folder: `Folder-${"x".repeat(2_000)}`,
      rfcMessageId: "<large-folder-evidence@example.test>"
    });
    const adapter = new OpaqueThreadingAdapter();
    await protectMessageInput(adapter, accountId, messageId);
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: adapter
    });

    await expect(drainUntilReady(accountId, {
      batchSize: 1,
      maxClosureEvidenceBytes: 1_024
    }, protectedRepository)).rejects.toBeInstanceOf(ThreadingEvidenceLimitError);
  });

  it("fails closed when protected input is read without its adapter", async () => {
    const accountId = await createAccount("missing-protection-adapter");
    const messageId = await seedMessage(accountId, {
      uid: 1,
      subject: "Missing adapter",
      rfcMessageId: "<missing-adapter@example.test>"
    });
    const adapter = new OpaqueThreadingAdapter();
    await protectMessageInput(adapter, accountId, messageId);

    await expect(repository.drainAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test"
    })).rejects.toThrow("protected threading metadata requires its protection adapter");
    await expect(repository.activateRun(
      accountId,
      randomUUID(),
      { requestedBy: "live-test" }
    )).rejects.toThrow("protected threading metadata requires its protection adapter");
    await expect(repository.compareRuns(
      accountId,
      randomUUID(),
      randomUUID()
    )).rejects.toThrow("protected threading metadata requires its protection adapter");
    const assignments = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.imap_thread_assignments WHERE account_id = $1",
      [accountId]
    );

    expect(assignments.rows[0]?.count).toBe("0");
  });

  it("releases threading locks when the protection adapter stalls", async () => {
    const accountId = await createAccount("stalled-protection-adapter");
    await markMetadataProtected(accountId);
    await seedMessage(accountId, {
      uid: 1,
      subject: "Stalled adapter",
      rfcMessageId: "<stalled-adapter@example.test>"
    });
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: new HangingThreadAssignmentAdapter(),
      metadataProtectionTimeoutMs: 50
    });
    await protectedRepository.drainAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test"
    });
    await protectedRepository.drainAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test"
    });

    await expect(protectedRepository.drainAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test"
    })).rejects.toThrow("metadata protection operation timed out");
    const lockClient = await pool.connect();
    try {
      const unlocked = await lockClient.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [`supamail.threading:${accountId}`]
      );
      expect(unlocked.rows[0]?.locked).toBe(true);
      await lockClient.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [`supamail.threading:${accountId}`]
      );
    } finally {
      lockClient.release();
    }
  });

  it("applies one aggregate adapter deadline to a bounded threading step", async () => {
    const accountId = await createAccount("aggregate-protection-deadline");
    await markMetadataProtected(accountId);
    for (let uid = 1; uid <= 20; uid += 1) {
      await seedMessage(accountId, {
        uid,
        subject: `Slow ${uid}`,
        rfcMessageId: `<slow-${uid}@example.test>`
      });
    }
    const adapter = new SlowThreadAssignmentAdapter();
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: adapter,
      metadataProtectionTimeoutMs: 50
    });
    await protectedRepository.drainAccount(accountId, {
      batchSize: 20,
      requestedBy: "live-test"
    });
    await protectedRepository.drainAccount(accountId, {
      batchSize: 20,
      requestedBy: "live-test"
    });

    await expect(protectedRepository.drainAccount(accountId, {
      batchSize: 20,
      requestedBy: "live-test"
    })).rejects.toThrow("metadata protection operation timed out");
    expect(adapter.maxActive).toBeLessThanOrEqual(16);
    const assignments = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.imap_thread_assignments WHERE account_id = $1",
      [accountId]
    );
    expect(assignments.rows[0]?.count).toBe("0");
  });

  it("does not charge database time to the metadata protection deadline", async () => {
    const accountId = await createAccount("database-before-protection-deadline");
    await markMetadataProtected(accountId);
    await seedMessage(accountId, {
      uid: 1,
      subject: "Slow compatibility query",
      rfcMessageId: "<slow-compatibility-query@example.test>"
    });
    const delayedPool = {
      connect: pool.connect.bind(pool),
      query: async (text: string, values?: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 75));
        return pool.query(text, values);
      }
    } as unknown as typeof pool;
    const protectedRepository = new ThreadingRepository(delayedPool, {
      metadataProtection: new OpaqueThreadingAdapter(),
      metadataProtectionTimeoutMs: 25
    });

    await expect(drainUntilReady(
      accountId,
      { batchSize: 1 },
      protectedRepository
    )).resolves.toMatchObject({ runStatus: "ready", ready: true });
  });

  it("retains permits for non-cooperative adapter calls after repeated timeouts", async () => {
    const adapter = new NonCooperativeThreadAssignmentAdapter();
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: adapter,
      metadataProtectionTimeoutMs: 50
    });
    const accountIdsForTimeout: string[] = [];
    for (let accountIndex = 0; accountIndex < 3; accountIndex += 1) {
      const accountId = await createAccount(`non-cooperative-adapter-${accountIndex}`);
      accountIdsForTimeout.push(accountId);
      await markMetadataProtected(accountId);
      for (let uid = 1; uid <= 20; uid += 1) {
        await seedMessage(accountId, {
          uid,
          subject: `Non-cooperative ${accountIndex}-${uid}`,
          rfcMessageId: `<non-cooperative-${accountIndex}-${uid}@example.test>`
        });
      }
      await protectedRepository.drainAccount(accountId, {
        batchSize: 20,
        requestedBy: "live-test"
      });
      await protectedRepository.drainAccount(accountId, {
        batchSize: 20,
        requestedBy: "live-test"
      });
    }

    for (const accountId of accountIdsForTimeout) {
      await expect(protectedRepository.drainAccount(accountId, {
        batchSize: 20,
        requestedBy: "live-test"
      })).rejects.toThrow("metadata protection operation timed out");
    }

    expect(adapter.started).toBe(16);
    expect(adapter.active).toBe(16);
  });

  it("does not retain large protected assignment envelopes in closure memory", async () => {
    const accountId = await createAccount("large-protected-assignment-envelope");
    await markMetadataProtected(accountId);
    const messageId = await seedMessage(accountId, {
      uid: 1,
      subject: "Small revealed assignment",
      rfcMessageId: "<large-protected-assignment-envelope@example.test>"
    });
    const adapter = new LargeThreadAssignmentEnvelopeAdapter();
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: adapter
    });
    const ready = await drainUntilReady(
      accountId,
      { batchSize: 1, maxClosureEvidenceBytes: 2_048 },
      protectedRepository
    );
    const stored = await pool.query<{ bytes: number }>(
      `SELECT octet_length(protected_metadata)::integer AS bytes
       FROM public.imap_thread_assignments
       WHERE run_id = $1 AND message_id = $2`,
      [ready.runId, messageId]
    );
    expect(stored.rows[0]?.bytes).toBeGreaterThan(400_000);

    await enqueueMessage(accountId, messageId);
    await expect(protectedRepository.drainAccount(accountId, {
      batchSize: 1,
      maxClosureEvidenceBytes: 2_048,
      requestedBy: "live-test"
    })).resolves.toMatchObject({ assignmentsChanged: 0 });
  });

  it("rolls back a threading write when the protected projection is incomplete", async () => {
    const accountId = await createAccount("incomplete-protected-thread");
    await markMetadataProtected(accountId);
    await seedMessage(accountId, {
      uid: 1,
      subject: "Incomplete projection",
      rfcMessageId: "<incomplete-projection@example.test>"
    });
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: new IncompleteThreadAssignmentAdapter()
    });

    await protectedRepository.drainAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test"
    });
    await protectedRepository.drainAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test"
    });
    await expect(protectedRepository.drainAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test"
    })).rejects.toThrow("metadata protection values must contain exactly the input fields");
    const assignments = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.imap_thread_assignments WHERE account_id = $1",
      [accountId]
    );
    expect(assignments.rows[0]?.count).toBe("0");
  });

  it("uses protected threading tokens for incremental closure and rollback history", async () => {
    const accountId = await createAccount("protected-thread-incremental");
    await markMetadataProtected(accountId);
    await seedMessage(accountId, {
      uid: 1,
      subject: "Protected decision",
      rfcMessageId: "<protected-root@example.test>"
    });
    const adapter = new OpaqueThreadingAdapter();
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: adapter
    });
    const ready = await drainUntilReady(accountId, { batchSize: 1 }, protectedRepository);
    await activateReviewed(protectedRepository, accountId, ready.runId as string);
    const beforeIncremental = await activeProjection(accountId);

    const reply = await seedMessage(accountId, {
      uid: 2,
      subject: "Re: Protected decision",
      rfcMessageId: "<protected-reply@example.test>",
      inReplyTo: "<protected-root@example.test>",
      referencesHeader: "<protected-root@example.test>"
    });
    await enqueueMessage(accountId, reply);
    const results = await drainRepositoryUntilIdle(protectedRepository, accountId);
    const material = [...results].reverse().find((result) => result.assignmentsChanged > 0);
    expect(material?.operationType).toBe("incremental");

    const assignments = await pool.query<{
      conversation_id: string;
      strict_message_id: string | null;
      protected_metadata: Buffer | null;
    }>(
      `SELECT conversation_id, strict_message_id, protected_metadata
       FROM public.imap_thread_active_assignments
       WHERE account_id = $1
       ORDER BY message_id`,
      [accountId]
    );
    expect(assignments.rows).toHaveLength(2);
    expect(new Set(assignments.rows.map((row) => row.conversation_id)).size).toBe(1);
    expect(assignments.rows.map((row) => row.strict_message_id)).not.toContain("protected-root@example.test");
    expect(assignments.rows.every((row) => row.protected_metadata !== null)).toBe(true);

    const history = await pool.query<{
      previous_assignment: Record<string, unknown> | null;
      next_assignment: Record<string, unknown> | null;
      protected_metadata: Buffer | null;
    }>(
      `SELECT previous_assignment, next_assignment, protected_metadata
       FROM public.imap_thread_assignment_history
       WHERE operation_id = $1
       ORDER BY message_id`,
      [material?.operationId]
    );
    expect(history.rows.length).toBe(material?.assignmentsChanged);
    expect(history.rows.every((row) => row.protected_metadata !== null)).toBe(true);
    expect(JSON.stringify(history.rows)).not.toContain("protected-root@example.test");
    expect(adapter.writes.some((write) => write.context.kind === "thread_assignment_history")).toBe(true);
    await expect(pool.query(
      `UPDATE public.imap_thread_assignments
       SET protected_metadata = NULL,
           protected_metadata_tokens = '{}'::jsonb
       WHERE account_id = $1
         AND protected_metadata IS NOT NULL`,
      [accountId]
    )).rejects.toThrow();
    await expect(pool.query(
      `UPDATE public.imap_thread_assignment_history
       SET protected_metadata = NULL,
           protected_metadata_tokens = '{}'::jsonb
       WHERE operation_id = $1`,
      [material?.operationId]
    )).rejects.toThrow();

    const beforeRejectedRollback = await activeProjection(accountId);
    await expect(new ThreadingRepository(pool, {
      metadataProtection: new IncompleteThreadHistoryRevealAdapter()
    }).rollbackOperation(
      accountId,
      material?.operationId as string,
      "live-test"
    )).rejects.toThrow("revealed metadata values must contain every requested field");
    expect(await activeProjection(accountId)).toEqual(beforeRejectedRollback);

    const rollback = await protectedRepository.rollbackOperation(
      accountId,
      material?.operationId as string,
      "live-test"
    );
    expect(rollback).toMatchObject({ operationType: "rollback", active: true, ready: true });
    const afterRollback = await activeProjection(accountId);
    expect(afterRollback.map(({ generation: _generation, ...row }) => row))
      .toEqual(beforeIncremental.map(({ generation: _generation, ...row }) => row));
    const operation = await pool.query<{ status: string }>(
      "SELECT status FROM public.imap_thread_operations WHERE id = $1",
      [material?.operationId]
    );
    expect(operation.rows[0]).toEqual({ status: "rolled_back" });
    const retainedHistory = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.imap_thread_assignment_history
       WHERE account_id = $1`,
      [accountId]
    );
    expect(retainedHistory.rows[0]?.count).toBe("0");
  });

  it("rolls back protected assignment history across bounded pages", async () => {
    const accountId = await createAccount("paged-protected-rollback");
    await markMetadataProtected(accountId);
    for (let uid = 1; uid <= 40; uid += 1) {
      await seedMessage(accountId, {
        uid,
        subject: `Protected root ${uid}`,
        rfcMessageId: `<protected-root-${uid}@example.test>`
      });
    }
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: new OpaqueThreadingAdapter()
    });
    const ready = await drainUntilReady(accountId, { batchSize: 40 }, protectedRepository);
    await activateReviewed(protectedRepository, accountId, ready.runId as string);
    const beforeIncremental = await activeProjection(accountId);

    for (let uid = 41; uid <= 80; uid += 1) {
      const rootUid = uid - 40;
      const reply = await seedMessage(accountId, {
        uid,
        subject: `Re: Protected root ${rootUid}`,
        rfcMessageId: `<protected-reply-${rootUid}@example.test>`,
        inReplyTo: `<protected-root-${rootUid}@example.test>`,
        referencesHeader: `<protected-root-${rootUid}@example.test>`
      });
      await enqueueMessage(accountId, reply);
    }
    const results = await drainRepositoryUntilIdle(protectedRepository, accountId, {
      batchSize: 40
    });
    const material = [...results].reverse().find((result) => result.assignmentsChanged >= 40);
    expect(material?.operationType).toBe("incremental");
    const history = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.imap_thread_assignment_history
       WHERE operation_id = $1`,
      [material?.operationId]
    );
    expect(Number(history.rows[0]?.count)).toBeGreaterThan(32);

    const afterIncremental = await activeProjection(accountId);
    const pageTwoIncompleteAdapter = new PageTwoIncompleteThreadHistoryRevealAdapter();
    await expect(new ThreadingRepository(pool, {
      metadataProtection: pageTwoIncompleteAdapter
    }).rollbackOperation(
      accountId,
      material?.operationId as string,
      "live-test"
    )).rejects.toThrow("revealed metadata values must contain every requested field");
    expect(pageTwoIncompleteAdapter.historyReveals).toBeGreaterThan(32);
    expect(await activeProjection(accountId)).toEqual(afterIncremental);

    await expect(protectedRepository.rollbackOperation(
      accountId,
      material?.operationId as string,
      "live-test"
    )).resolves.toMatchObject({
      operationType: "rollback",
      assignmentsChanged: Number(history.rows[0]?.count)
    });
    const afterRollback = await activeProjection(accountId);
    expect(afterRollback.map(({ generation: _generation, ...row }) => row))
      .toEqual(beforeIncremental.map(({ generation: _generation, ...row }) => row));
  });

  it("keeps subject fallback functional with protected subject tokens", async () => {
    const accountId = await createAccount("protected-subject-fallback");
    await markMetadataProtected(accountId);
    await seedMessage(accountId, {
      uid: 1,
      subject: "Re: Protected budget",
      fromEmail: "bob@example.test",
      toEmails: ["alice@example.test"],
      rfcMessageId: "<protected-budget-reply@example.test>",
      internalDate: "2026-02-02T12:00:00.000Z"
    });
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: new OpaqueThreadingAdapter()
    });
    const ready = await drainUntilReady(accountId, { batchSize: 1 }, protectedRepository);
    await activateReviewed(protectedRepository, accountId, ready.runId as string);

    const root = await seedMessage(accountId, {
      uid: 2,
      subject: "Protected budget",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<protected-budget-root@example.test>",
      internalDate: "2026-02-01T12:00:00.000Z"
    });
    await enqueueMessage(accountId, root);
    await drainRepositoryUntilIdle(protectedRepository, accountId);

    const rows = await activeProjection(accountId);
    expect(new Set(rows.map((row) => row.conversation_id)).size).toBe(1);
    expect(rows.every((row) => row.assignment_method === "subject_fallback")).toBe(true);
  });

  it("uses protected reference tokens to resolve an existing orphan family", async () => {
    const accountId = await createAccount("protected-orphan-resolution");
    await markMetadataProtected(accountId);
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: new OpaqueThreadingAdapter()
    });
    const firstSibling = await seedMessage(accountId, {
      uid: 1,
      subject: "Re: Protected missing decision",
      rfcMessageId: "<protected-sibling-1@example.test>",
      inReplyTo: "<protected-missing-parent@example.test>",
      referencesHeader: "<protected-missing-parent@example.test>"
    });
    const secondSibling = await seedMessage(accountId, {
      uid: 2,
      subject: "Re: Protected missing decision",
      rfcMessageId: "<protected-sibling-2@example.test>",
      inReplyTo: "<protected-missing-parent@example.test>",
      referencesHeader: "<protected-missing-parent@example.test>"
    });
    const ready = await drainUntilReady(accountId, { batchSize: 1 }, protectedRepository);
    await activateReviewed(protectedRepository, accountId, ready.runId as string);
    expect((await activeProjection(accountId)).every((row) => row.is_provisional)).toBe(true);

    const parent = await seedMessage(accountId, {
      uid: 3,
      subject: "Protected missing decision",
      rfcMessageId: "<protected-missing-parent@example.test>"
    });
    await enqueueMessage(accountId, parent);
    const operations = await drainRepositoryUntilIdle(protectedRepository, accountId);

    const family = await activeProjection(accountId);
    expect(family).toHaveLength(3);
    expect(family.every((row) => !row.is_provisional)).toBe(true);
    expect(Math.max(...operations.map((result) => result.messagesConsidered))).toBe(3);
    expect(firstSibling).not.toBe(secondSibling);
  });

  it("uses protected provider-thread tokens for incremental closure", async () => {
    const accountId = await createAccount("protected-provider-thread");
    await markMetadataProtected(accountId);
    await seedMessage(accountId, {
      uid: 1,
      rfcMessageId: "<provider-first@example.test>",
      providerThreadId: "shared-provider-thread",
      providerThreadNamespace: "gmail"
    });
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: new OpaqueThreadingAdapter()
    });
    const ready = await drainUntilReady(accountId, { batchSize: 1 }, protectedRepository);
    await activateReviewed(protectedRepository, accountId, ready.runId as string);

    const second = await seedMessage(accountId, {
      uid: 2,
      rfcMessageId: "<provider-second@example.test>",
      providerThreadId: "shared-provider-thread",
      providerThreadNamespace: "gmail"
    });
    await enqueueMessage(accountId, second);
    const operations = await drainRepositoryUntilIdle(protectedRepository, accountId);

    expect(Math.max(...operations.map((step) => step.messagesConsidered))).toBe(2);
    expect(new Set((await activeProjection(accountId)).map((row) => row.conversation_id)).size).toBe(1);
  });

  it("uses protected delivery-fingerprint tokens for incremental closure", async () => {
    const accountId = await createAccount("protected-delivery-fingerprint");
    await markMetadataProtected(accountId);
    const rawMime = Buffer.from("From: alice@example.test\r\nTo: bob@example.test\r\n\r\nsame delivery");
    await seedMessage(accountId, {
      uid: 1,
      folder: "INBOX",
      rawMime
    });
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: new OpaqueThreadingAdapter()
    });
    const ready = await drainUntilReady(accountId, { batchSize: 1 }, protectedRepository);
    await activateReviewed(protectedRepository, accountId, ready.runId as string);

    const copy = await seedMessage(accountId, {
      uid: 2,
      folder: "Sent",
      rawMime
    });
    await enqueueMessage(accountId, copy);
    const operations = await drainRepositoryUntilIdle(protectedRepository, accountId);

    expect(Math.max(...operations.map((step) => step.messagesConsidered))).toBe(2);
    const rows = await activeProjection(accountId);
    expect(new Set(rows.map((row) => row.delivery_key)).size).toBe(1);
    expect(new Set(rows.map((row) => row.conversation_id)).size).toBe(1);
  });

  it("threads physical copies from committed evidence after the body payload is unreadable", async () => {
    const accountId = await createAccount("evidence-without-payload");
    const messageId = "<evidence-without-payload@example.test>";
    const first = await seedMessage(accountId, {
      uid: 1,
      folder: "INBOX",
      subject: "Evidence seam",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: messageId
    });
    const second = await seedMessage(accountId, {
      uid: 2,
      folder: "Sent",
      subject: "Evidence seam",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: messageId
    });
    const rawMime = Buffer.from(
      `Message-ID: ${messageId}\r\n` +
      "Date: Thu, 15 Jan 2026 12:00:00 +0000\r\n" +
      "From: alice@example.test\r\n" +
      "To: bob@example.test\r\n" +
      "Subject: Evidence seam\r\n\r\n" +
      "threading evidence survives"
    );
    for (const id of [first, second]) {
      await mirror.storeBody({
        messageId: id,
        rawMime,
        rawBytes: rawMime.byteLength,
        rawTruncated: false,
        bodyText: "threading evidence survives",
        bodyHtml: null,
        bodyPlain: "threading evidence survives",
        selectedTextPart: "1",
        selectedTextFormat: "plain",
        headersJson: {
          "message-id": messageId,
          date: "Thu, 15 Jan 2026 12:00:00 +0000",
          from: "alice@example.test",
          to: "bob@example.test",
          subject: "Evidence seam"
        },
        mimeStructure: { type: "text", subtype: "plain" },
        parserWarnings: [],
        evidence: []
      });
    }

    await pool.query(
      `UPDATE public.imap_message_bodies
       SET raw_mime = NULL,
           body_text = NULL,
           body_html = NULL,
           body_plain = NULL,
           selected_text_part = NULL,
           selected_text_format = NULL
       WHERE message_id = ANY($1::uuid[])`,
      [[first, second]]
    );
    const evidence = await pool.query<{
      search_extract: string | null;
      raw_mime_sha256: string | null;
      threading_payload_sha256: string | null;
    }>(
      `SELECT search_extract, raw_mime_sha256, threading_payload_sha256
       FROM public.imap_message_bodies
       WHERE message_id = ANY($1::uuid[])
       ORDER BY message_id`,
      [[first, second]]
    );
    expect(evidence.rows).toHaveLength(2);
    expect(evidence.rows.every((row) =>
      row.search_extract === "threading evidence survives"
      && /^[0-9a-f]{64}$/.test(row.raw_mime_sha256 ?? "")
      && /^[0-9a-f]{64}$/.test(row.threading_payload_sha256 ?? "")
    )).toBe(true);

    const ready = await drainUntilReady(accountId, { batchSize: 1 });
    const rows = await projection(ready.runId as string);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.delivery_key)).size).toBe(1);
    expect(new Set(rows.map((row) => row.conversation_id)).size).toBe(1);
  });

  it("atomically activates the first projection when the worker explicitly opts in", async () => {
    const accountId = await createAccount("initial-auto-activation");
    await seedMessage(accountId, {
      uid: 1,
      subject: "First projection",
      rfcMessageId: "<initial-auto-activation@example.test>"
    });

    let last: ThreadingRunResult | null = null;
    for (let pass = 0; pass < 200; pass += 1) {
      last = await repository.drainAccount(accountId, {
        batchSize: 1,
        requestedBy: "live-test-worker",
        activateInitial: true
      });
      if (last.active) break;
    }

    expect(last).toMatchObject({
      runStatus: "active",
      stage: "ready",
      ready: true,
      active: true
    });
    const active = await activeProjection(accountId);
    expect(active).toHaveLength(1);
    expect(active[0]?.run_id).toBe(last?.runId);
  });

  it("keeps rebuilds review-gated when initial auto-activation is enabled", async () => {
    const accountId = await createAccount("rebuild-review-gate");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Reviewed baseline",
      rfcMessageId: "<rebuild-review-gate@example.test>"
    });

    let baseline: ThreadingRunResult | null = null;
    for (let pass = 0; pass < 200; pass += 1) {
      baseline = await repository.drainAccount(accountId, {
        batchSize: 1,
        requestedBy: "live-test-worker",
        activateInitial: true
      });
      if (baseline.active) break;
    }
    expect(baseline?.active).toBe(true);

    const rebuild = await repository.rebuildAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test-worker",
      reason: "verify review boundary",
      activateInitial: true
    });

    expect(rebuild).toMatchObject({ runStatus: "ready", active: false, ready: true });
    const active = await activeProjection(accountId);
    expect(active).toHaveLength(1);
    expect(active[0]?.run_id).toBe(baseline?.runId);
    expect(rebuild.runId).not.toBe(baseline?.runId);
  });

  it("rediscovers a ready first projection after auto-activation is interrupted", async () => {
    const accountId = await createAccount("initial-auto-activation-retry");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Retry first activation",
      rfcMessageId: "<initial-auto-activation-retry@example.test>"
    });

    const ready = await drainUntilReady(accountId, { batchSize: 1 });
    expect(ready).toMatchObject({ runStatus: "ready", active: false, ready: true });
    expect(await activeProjection(accountId)).toHaveLength(0);

    expect(await repository.listAccountsNeedingWork(10)).not.toContain(accountId);
    expect(await repository.listAccountsNeedingWork(10, { activateInitial: true })).toContain(accountId);

    const activated = await repository.drainAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test-worker",
      activateInitial: true
    });
    expect(activated).toMatchObject({ runStatus: "active", active: true, ready: true });
    expect(await activeProjection(accountId)).toHaveLength(1);
    expect(await repository.listAccountsNeedingWork(10, { activateInitial: true })).not.toContain(accountId);
  });

  it("resolves missing parents incrementally without sweeping unrelated mail", async () => {
    const accountId = await createAccount("orphan-resolution");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Unrelated",
      rfcMessageId: "<unrelated@example.test>"
    });
    const ready = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, ready.runId as string);

    const firstSibling = await seedMessage(accountId, {
      uid: 2,
      subject: "Re: Missing decision",
      fromEmail: "bob@example.test",
      toEmails: ["alice@example.test"],
      rfcMessageId: "<sibling-1@example.test>",
      inReplyTo: "<missing-parent@example.test>",
      referencesHeader: "<missing-parent@example.test>"
    });
    const secondSibling = await seedMessage(accountId, {
      uid: 3,
      subject: "Re: Missing decision",
      fromEmail: "carol@example.test",
      toEmails: ["alice@example.test"],
      rfcMessageId: "<sibling-2@example.test>",
      inReplyTo: "<missing-parent@example.test>",
      referencesHeader: "<missing-parent@example.test>"
    });
    await enqueueMessage(accountId, firstSibling);
    await enqueueMessage(accountId, secondSibling);
    await drainUntilIdle(accountId);

    const provisional = await projection(ready.runId as string);
    const siblings = provisional.filter((row) => row.uid === "2" || row.uid === "3");
    expect(new Set(siblings.map((row) => row.conversation_id)).size).toBe(1);
    expect(siblings.every((row) => row.is_provisional)).toBe(true);
    const unrelatedGeneration = provisional.find((row) => row.uid === "1")?.generation;

    const parent = await seedMessage(accountId, {
      uid: 4,
      subject: "Missing decision",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test", "carol@example.test"],
      rfcMessageId: "<missing-parent@example.test>"
    });
    await enqueueMessage(accountId, parent);
    const operations = await drainUntilIdle(accountId);

    const resolved = await projection(ready.runId as string);
    const family = resolved.filter((row) => row.uid !== "1");
    expect(new Set(family.map((row) => row.conversation_id)).size).toBe(1);
    expect(family.every((row) => !row.is_provisional)).toBe(true);
    expect(resolved.find((row) => row.uid === "1")?.generation).toBe(unrelatedGeneration);
    expect(Math.max(...operations.map((result) => result.messagesConsidered))).toBe(3);
  });

  it("revisits a weak subject bucket when the human root arrives after the reply", async () => {
    const accountId = await createAccount("late-subject-root");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Re: Budget approval",
      fromEmail: "bob@example.test",
      toEmails: ["alice@example.test"],
      rfcMessageId: "<early-reply@example.test>",
      internalDate: "2026-02-02T12:00:00.000Z"
    });
    const ready = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, ready.runId as string);
    expect((await activeProjection(accountId))[0]?.assignment_method).toBe("standalone");

    const lateRoot = await seedMessage(accountId, {
      uid: 2,
      subject: "Budget approval",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<late-root@example.test>",
      internalDate: "2026-02-01T12:00:00.000Z"
    });
    await enqueueMessage(accountId, lateRoot);
    await drainUntilIdle(accountId);

    const rows = await activeProjection(accountId);
    expect(new Set(rows.map((row) => row.conversation_id)).size).toBe(1);
    expect(rows.every((row) => row.assignment_method === "subject_fallback")).toBe(true);
    expect(rows.every((row) => row.confidence === "low" && row.is_provisional)).toBe(true);
  });

  it("retires singleton subject buckets in bounded batches", async () => {
    const accountId = await createAccount("singleton-subject-batches");
    for (let uid = 1; uid <= 15; uid += 1) {
      await seedMessage(accountId, {
        uid,
        subject: `Re: Unique topic ${uid}`,
        fromEmail: `sender-${uid}@example.test`,
        toEmails: [`recipient-${uid}@example.test`],
        rfcMessageId: `<singleton-subject-${uid}@example.test>`
      });
    }

    let runId: string | null = null;
    for (let pass = 0; pass < 30; pass += 1) {
      const result = await repository.drainAccount(accountId, { batchSize: 5, requestedBy: "live-test" });
      runId = result.runId;
      if (result.stage === "subject") break;
    }
    expect(runId).not.toBeNull();
    const before = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.imap_thread_subject_work WHERE run_id = $1",
      [runId]
    );
    expect(Number(before.rows[0]?.count)).toBe(15);

    await repository.drainAccount(accountId, { batchSize: 5, requestedBy: "live-test" });
    const after = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.imap_thread_subject_work WHERE run_id = $1",
      [runId]
    );
    expect(Number(after.rows[0]?.count)).toBeLessThanOrEqual(10);
  });

  it("retires singleton subject buckets even when older multi-message work sorts first", async () => {
    const accountId = await createAccount("singleton-subject-lookahead");
    let uid = 1;
    for (let topic = 1; topic <= 5; topic += 1) {
      await seedMessage(accountId, {
        uid: uid++,
        subject: `Queued pair ${topic}`,
        fromEmail: `sender-${topic}@example.test`,
        toEmails: [`recipient-${topic}@example.test`],
        rfcMessageId: `<queued-pair-root-${topic}@example.test>`
      });
      await seedMessage(accountId, {
        uid: uid++,
        subject: `Re: Queued pair ${topic}`,
        fromEmail: `recipient-${topic}@example.test`,
        toEmails: [`sender-${topic}@example.test`],
        rfcMessageId: `<queued-pair-reply-${topic}@example.test>`
      });
    }
    for (let topic = 1; topic <= 5; topic += 1) {
      await seedMessage(accountId, {
        uid: uid++,
        subject: `Re: Later singleton ${topic}`,
        fromEmail: `singleton-${topic}@example.test`,
        toEmails: [`recipient-${topic}@example.test`],
        rfcMessageId: `<later-singleton-${topic}@example.test>`
      });
    }

    let runId: string | null = null;
    for (let pass = 0; pass < 30; pass += 1) {
      const result = await repository.drainAccount(accountId, { batchSize: 5, requestedBy: "live-test" });
      runId = result.runId;
      if (result.stage === "subject") break;
    }
    expect(runId).not.toBeNull();

    await pool.query(
      `UPDATE public.imap_thread_subject_work work
          SET enqueued_at = CASE WHEN member_counts.count > 1
                                 THEN '2026-01-01T00:00:00Z'::timestamptz
                                 ELSE '2026-01-02T00:00:00Z'::timestamptz END
         FROM (
           SELECT subject_key, count(*)::integer AS count
           FROM public.imap_thread_assignments
           WHERE run_id = $1
           GROUP BY subject_key
         ) member_counts
        WHERE work.run_id = $1
          AND work.subject_key = member_counts.subject_key`,
      [runId]
    );

    await repository.drainAccount(accountId, { batchSize: 5, requestedBy: "live-test" });
    const remaining = await pool.query<{ members: number; buckets: string }>(
      `SELECT member_counts.count AS members, count(*)::text AS buckets
       FROM public.imap_thread_subject_work work
       JOIN (
         SELECT subject_key, count(*)::integer AS count
         FROM public.imap_thread_assignments
         WHERE run_id = $1
         GROUP BY subject_key
       ) member_counts ON member_counts.subject_key = work.subject_key
       WHERE work.run_id = $1
       GROUP BY member_counts.count
       ORDER BY member_counts.count`,
      [runId]
    );
    expect(remaining.rows).toEqual([{ members: 2, buckets: "5" }]);
  });

  it("retires multi-message subject buckets with fewer than two eligible deliveries", async () => {
    const accountId = await createAccount("inert-multi-subject-buckets");
    const mirroredRaw = Buffer.from("identical mirrored delivery");
    await seedMessage(accountId, {
      uid: 1,
      folder: "Sent",
      subject: "Re: Mirrored notice",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<mirrored-notice@example.test>",
      rawMime: mirroredRaw
    });
    await seedMessage(accountId, {
      uid: 2,
      folder: "INBOX",
      subject: "Re: Mirrored notice",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<mirrored-notice@example.test>",
      rawMime: mirroredRaw
    });
    await seedMessage(accountId, {
      uid: 3,
      subject: "Automated notice",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<automated-notice-root@example.test>"
    });
    await seedMessage(accountId, {
      uid: 4,
      subject: "Re: Automated notice",
      fromEmail: "bob@example.test",
      toEmails: ["alice@example.test"],
      rfcMessageId: "<automated-notice-reply@example.test>",
      headersJson: { "auto-submitted": "auto-generated" }
    });
    await seedMessage(accountId, {
      uid: 5,
      subject: "Actionable notice",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<actionable-notice-root@example.test>"
    });
    await seedMessage(accountId, {
      uid: 6,
      subject: "Re: Actionable notice",
      fromEmail: "bob@example.test",
      toEmails: ["alice@example.test"],
      rfcMessageId: "<actionable-notice-reply@example.test>"
    });

    let runId: string | null = null;
    for (let pass = 0; pass < 30; pass += 1) {
      const result = await repository.drainAccount(accountId, { batchSize: 5, requestedBy: "live-test" });
      runId = result.runId;
      if (result.stage === "subject") break;
    }
    expect(runId).not.toBeNull();

    const pruned = await repository.drainAccount(accountId, { batchSize: 5, requestedBy: "live-test" });
    expect(pruned).toMatchObject({ queueItemsProcessed: 2, assignmentsChanged: 0 });
    const remaining = await pool.query<{ subject_base: string; eligible_deliveries: string }>(
      `SELECT min(assignment.subject_base) AS subject_base,
              count(DISTINCT assignment.delivery_key)
                FILTER (WHERE assignment.subject_fallback_eligible)::text AS eligible_deliveries
       FROM public.imap_thread_subject_work work
       JOIN public.imap_thread_assignments assignment
         ON assignment.run_id = work.run_id
        AND assignment.subject_key = work.subject_key
       WHERE work.run_id = $1
       GROUP BY work.subject_key`,
      [runId]
    );
    expect(remaining.rows).toEqual([{ subject_base: "actionable notice", eligible_deliveries: "2" }]);
  });

  it("skips an oversized common-subject bucket instead of risking a false merge", async () => {
    const accountId = await createAccount("common-subject-cap");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Status",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<status-root@example.test>",
      internalDate: "2026-03-01T12:00:00.000Z"
    });
    await seedMessage(accountId, {
      uid: 2,
      subject: "Re: Status",
      fromEmail: "bob@example.test",
      toEmails: ["alice@example.test"],
      rfcMessageId: "<status-reply@example.test>",
      internalDate: "2026-03-02T12:00:00.000Z"
    });
    await seedMessage(accountId, {
      uid: 3,
      subject: "Status",
      fromEmail: "carol@example.test",
      toEmails: ["dave@example.test"],
      rfcMessageId: "<other-status@example.test>",
      internalDate: "2026-03-01T12:00:00.000Z"
    });

    const ready = await drainUntilReady(accountId, {
      batchSize: 1,
      maxSubjectBucketMessages: 2
    });
    const rows = await projection(ready.runId as string);
    expect(new Set(rows.map((row) => row.conversation_id)).size).toBe(3);
    expect(rows.every((row) => row.assignment_method === "standalone")).toBe(true);

    const summary = await pool.query<{ oversized: string }>(
      `SELECT coalesce(summary->>'oversized_subject_buckets', '0') AS oversized
       FROM public.imap_thread_runs WHERE id = $1`,
      [ready.runId]
    );
    expect(summary.rows[0]?.oversized).toBe("1");
  });

  it("rolls an activation pointer back atomically and rebuilds safely from the paused state", async () => {
    const accountId = await createAccount("activation-rollback");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Launch",
      rfcMessageId: "<launch@example.test>"
    });
    const initial = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, initial.runId as string);

    const shadow = await repository.rebuildAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test",
      reason: "shadow comparison"
    });
    expect(shadow).toMatchObject({ runStatus: "ready", active: false });
    expect((await activeProjection(accountId))[0]?.run_id).toBe(initial.runId);

    const activation = await activateReviewed(
      repository,
      accountId,
      shadow.runId as string,
      "live-test",
      "benchmark passed"
    );
    expect((await activeProjection(accountId))[0]?.run_id).toBe(shadow.runId);

    const rolledBack = await repository.rollbackOperation(
      accountId,
      activation.operationId as string,
      "live-test"
    );
    expect(rolledBack).toMatchObject({ runStatus: "rolled_back", active: false, ready: false });
    expect((await activeProjection(accountId))[0]?.run_id).toBe(initial.runId);

    const paused = await pool.query<{ paused: boolean }>(
      "SELECT paused_at IS NOT NULL AS paused FROM public.imap_thread_state WHERE account_id = $1",
      [accountId]
    );
    expect(paused.rows[0]?.paused).toBe(true);

    const recovered = await repository.rebuildAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test",
      reason: "post-rollback clean rebuild"
    });
    expect(recovered).toMatchObject({ runStatus: "ready", active: false });
    await activateReviewed(repository, accountId, recovered.runId as string);
    const resumed = await pool.query<{ paused: boolean }>(
      "SELECT paused_at IS NOT NULL AS paused FROM public.imap_thread_state WHERE account_id = $1",
      [accountId]
    );
    expect(resumed.rows[0]?.paused).toBe(false);
  });

  it("reverses the latest incremental assignment operation without mutating raw messages", async () => {
    const accountId = await createAccount("incremental-rollback");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Decision",
      rfcMessageId: "<decision@example.test>"
    });
    const initial = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, initial.runId as string);

    const reply = await seedMessage(accountId, {
      uid: 2,
      subject: "Re: Decision",
      rfcMessageId: "<decision-reply@example.test>",
      inReplyTo: "<decision@example.test>",
      referencesHeader: "<decision@example.test>"
    });
    await enqueueMessage(accountId, reply);
    const results = await drainUntilIdle(accountId);
    const material = [...results].reverse().find((result) => result.assignmentsChanged > 0);
    expect(material?.operationType).toBe("incremental");
    expect(await activeProjection(accountId)).toHaveLength(2);

    // Operations written before migration 0020 do not contain the new array in
    // their immutable JSON snapshot. Rollback must treat that absent field as
    // an empty legacy value instead of rejecting or inventing evidence.
    await pool.query(
      `UPDATE public.imap_thread_assignment_history
       SET previous_assignment = previous_assignment - 'delivery_fingerprint_hashes'
       WHERE operation_id = $1 AND previous_assignment IS NOT NULL`,
      [material?.operationId]
    );

    const rollback = await repository.rollbackOperation(
      accountId,
      material?.operationId as string,
      "live-test"
    );
    expect(rollback).toMatchObject({
      operationType: "rollback",
      assignmentsChanged: 2,
      active: true,
      ready: true
    });
    expect(await activeProjection(accountId)).toHaveLength(1);

    const raw = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.imap_messages WHERE account_id = $1",
      [accountId]
    );
    expect(raw.rows[0]?.count).toBe("2");
    const restoredFingerprintState = await pool.query<{ count: string }>(
      `SELECT cardinality(delivery_fingerprint_hashes)::text AS count
       FROM public.imap_thread_assignments
       WHERE run_id = $1 AND message_id = $2`,
      [initial.runId, (await pool.query<{ id: string }>(
        `SELECT id FROM public.imap_messages
         WHERE account_id = $1 AND uid = 1 ORDER BY id LIMIT 1`,
        [accountId]
      )).rows[0]?.id]
    );
    expect(restoredFingerprintState.rows[0]?.count).toBe("0");
    const audit = await pool.query<{
      original_status: string;
      rollback_changes: string;
      reverses_operation_id: string;
      retained_history: string;
    }>(
      `SELECT original.status AS original_status,
              rollback.summary->>'assignments_changed' AS rollback_changes,
              rollback.reverses_operation_id::text AS reverses_operation_id,
              (SELECT count(*)::text FROM public.imap_thread_assignment_history h
               WHERE h.account_id = $3) AS retained_history
       FROM public.imap_thread_operations original
       JOIN public.imap_thread_operations rollback ON rollback.id = $2
       WHERE original.id = $1`,
      [material?.operationId, rollback.operationId, accountId]
    );
    expect(audit.rows[0]).toEqual({
      original_status: "rolled_back",
      rollback_changes: "2",
      reverses_operation_id: material?.operationId,
      retained_history: "0"
    });
  });

  it("retains full assignment history only for the latest active incremental operation", async () => {
    const accountId = await createAccount("bounded-incremental-history");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Initial message",
      rfcMessageId: "<bounded-history-initial@example.test>"
    });
    const initial = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, initial.runId as string);

    const firstArrival = await seedMessage(accountId, {
      uid: 2,
      subject: "First arrival",
      rfcMessageId: "<bounded-history-first@example.test>"
    });
    await enqueueMessage(accountId, firstArrival);
    const firstResults = await drainUntilIdle(accountId);
    const firstMaterial = [...firstResults].reverse().find((result) => result.assignmentsChanged > 0);
    expect(firstMaterial?.operationType).toBe("incremental");

    const secondArrival = await seedMessage(accountId, {
      uid: 3,
      subject: "Second arrival",
      rfcMessageId: "<bounded-history-second@example.test>"
    });
    await enqueueMessage(accountId, secondArrival);
    const secondResults = await drainUntilIdle(accountId);
    const secondMaterial = [...secondResults].reverse().find((result) => result.assignmentsChanged > 0);
    expect(secondMaterial?.operationType).toBe("incremental");
    expect(secondMaterial?.operationId).not.toBe(firstMaterial?.operationId);

    const retained = await pool.query<{ operation_id: string; changes: string }>(
      `SELECT operation_id, count(*)::text AS changes
       FROM public.imap_thread_assignment_history
       WHERE account_id = $1
       GROUP BY operation_id
       ORDER BY operation_id`,
      [accountId]
    );
    expect(retained.rows).toEqual([{
      operation_id: secondMaterial?.operationId as string,
      changes: "1"
    }]);

    const rollback = await repository.rollbackOperation(
      accountId,
      secondMaterial?.operationId as string,
      "live-test"
    );
    expect(rollback).toMatchObject({
      operationType: "rollback",
      assignmentsChanged: 1,
      active: true,
      ready: true
    });
    expect(await activeProjection(accountId)).toHaveLength(2);

    const historyAfterRollback = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.imap_thread_assignment_history
       WHERE account_id = $1`,
      [accountId]
    );
    expect(historyAfterRollback.rows[0]?.count).toBe("0");
  });

  it("preserves retained rollback history and recomputes survivors when retention purges a thread member", async () => {
    const accountId = await createAccount("purge-invalidation");
    const root = await seedMessage(accountId, {
      uid: 1,
      subject: "Retention",
      rfcMessageId: "<retention-root@example.test>"
    });
    await seedMessage(accountId, {
      uid: 2,
      subject: "Re: Retention",
      rfcMessageId: "<retention-reply@example.test>",
      inReplyTo: "<retention-root@example.test>",
      referencesHeader: "<retention-root@example.test>"
    });
    const ready = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, ready.runId as string);

    await pool.query("UPDATE public.imap_messages SET subject = 'Retention evidence' WHERE id = $1", [root]);
    await drainUntilIdle(accountId);

    const historyBefore = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.imap_thread_assignment_history
       WHERE account_id = $1 AND message_id = $2`,
      [accountId, root]
    );
    expect(Number(historyBefore.rows[0]?.count)).toBeGreaterThan(0);

    await pool.query(
      `UPDATE public.imap_messages
       SET deleted_in_provider = true,
           deleted_reason = 'MOVED_OUT',
           provider_deleted_at = now() - interval '31 days'
       WHERE id = $1`,
      [root]
    );
    expect(await mirror.runPurgeJob()).toEqual({ purged: 1 });

    const historyAfter = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.imap_thread_assignment_history
       WHERE account_id = $1 AND message_id = $2`,
      [accountId, root]
    );
    expect(historyAfter.rows[0]?.count).toBe(historyBefore.rows[0]?.count);
    await drainUntilIdle(accountId);
    const survivor = await activeProjection(accountId);
    expect(survivor).toHaveLength(1);
    expect(survivor[0]).toMatchObject({
      uid: "2",
      root_reference: "retention-root@example.test",
      parent_reference: "retention-root@example.test",
      is_provisional: true
    });
  });

  it("backfills complete body fingerprints before using them to collapse mirrored copies", async () => {
    const accountId = await createAccount("body-evidence");
    const rawMime = Buffer.from(
      "Message-ID: <mirror@example.test>\r\nSubject: Mirror\r\n\r\nSame delivered bytes"
    );
    await seedMessage(accountId, {
      uid: 1,
      folder: "INBOX",
      subject: "Mirror",
      rfcMessageId: "<mirror@example.test>",
      rawMime,
      rawMimeSha256: null
    });
    await seedMessage(accountId, {
      uid: 9,
      folder: "Archive",
      subject: "Mirror",
      rfcMessageId: "<mirror@example.test>",
      rawMime,
      rawMimeSha256: null
    });

    const ready = await drainUntilReady(accountId, { batchSize: 1 });
    const rows = await projection(ready.runId as string);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.delivery_key)).size).toBe(1);
    expect((rows[0]?.evidence.collapsed_physical_ids as string[])).toHaveLength(2);

    const hashes = await pool.query<{ raw_mime_sha256: string | null }>(
      `SELECT b.raw_mime_sha256
       FROM public.imap_message_bodies b
       JOIN public.imap_messages m ON m.id = b.message_id
       WHERE m.account_id = $1
       ORDER BY m.folder_path`,
      [accountId]
    );
    expect(hashes.rows).toEqual([
      { raw_mime_sha256: createHash("sha256").update(rawMime).digest("hex") },
      { raw_mime_sha256: createHash("sha256").update(rawMime).digest("hex") }
    ]);
  });

  it("closes a bounded rebuild over copies that share one of several delivery fingerprints", async () => {
    const accountId = await createAccount("overlapping-delivery-evidence");
    const parsedDigest = "b".repeat(64);
    const messageIds = await Promise.all([
      seedMessage(accountId, {
        uid: 1,
        folder: "INBOX",
        subject: "Overlapping fingerprint mirror",
        fromEmail: "sender@example.test",
        toEmails: ["recipient@example.test"],
        rfcMessageId: "<explicit-copy@example.test>",
        headersJson: {
          "message-id": "<conflicting-copy@example.test>",
          "list-unsubscribe": "<https://example.test/unsubscribe>"
        }
      }),
      seedMessage(accountId, {
        uid: 1,
        folder: "INBOX.INBOX",
        subject: "Overlapping fingerprint mirror",
        fromEmail: "sender@example.test",
        toEmails: ["recipient@example.test"],
        rfcMessageId: "<explicit-copy@example.test>",
        headersJson: {
          "message-id": "<conflicting-copy@example.test>",
          "list-unsubscribe": "<https://example.test/unsubscribe>"
        }
      })
    ]);
    await pool.query(
      `INSERT INTO public.imap_message_bodies (
         message_id, raw_mime_sha256, parsed_delivery_sha256,
         raw_bytes, raw_truncated, headers_json
       ) VALUES
         ($1, $3, $4, 128, false, '{}'::jsonb),
         ($2, NULL, $4, 128, false, '{}'::jsonb)`,
      [messageIds[0], messageIds[1], "a".repeat(64), parsedDigest]
    );

    const ready = await drainUntilReady(accountId, { batchSize: 1 });
    const rows = await projection(ready.runId as string);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.subject_fallback_eligible === false)).toBe(true);
    expect(new Set(rows.map((row) => row.delivery_key)).size).toBe(1);
    expect(new Set(rows.map((row) => row.conversation_id)).size).toBe(1);
    expect(rows.every((row) =>
      (row.evidence.collapsed_physical_ids as string[]).length === 2
    )).toBe(true);
    const persistedFingerprints = await pool.query<{ count: string }>(
      `SELECT cardinality(delivery_fingerprint_hashes)::text AS count
       FROM public.imap_thread_assignments
       WHERE run_id = $1
       ORDER BY message_id`,
      [ready.runId]
    );
    expect(persistedFingerprints.rows.map((row) => Number(row.count)).sort((left, right) => right - left))
      .toEqual([2, 1]);
  });

  it("closes a bounded rebuild over exact metadata copies without body evidence", async () => {
    const accountId = await createAccount("metadata-copy-closure");
    await Promise.all([
      seedMessage(accountId, {
        uid: 1,
        folder: "INBOX",
        subject: "Metadata mirror",
        fromEmail: "sender@example.test",
        toEmails: ["recipient@example.test"],
        rfcMessageId: "<metadata-mirror@example.test>",
        internalDate: "2026-01-01T12:00:00.000Z"
      }),
      seedMessage(accountId, {
        uid: 1,
        folder: "INBOX.INBOX",
        subject: "Metadata mirror",
        fromEmail: "sender@example.test",
        toEmails: ["recipient@example.test"],
        rfcMessageId: "<metadata-mirror@example.test>",
        internalDate: "2026-01-01T12:00:00.000Z"
      })
    ]);

    const ready = await drainUntilReady(accountId, { batchSize: 1 });
    const rows = await projection(ready.runId as string);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.delivery_key)).size).toBe(1);
    expect(new Set(rows.map((row) => row.conversation_id)).size).toBe(1);
    expect(rows.every((row) =>
      (row.evidence.collapsed_physical_ids as string[]).length === 2
    )).toBe(true);
  });

  it("enforces the persisted fingerprint hash constraint and safe empty default", async () => {
    const accountId = await createAccount("fingerprint-constraint");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Fingerprint constraint",
      fromEmail: "sender@example.test",
      toEmails: ["recipient@example.test"],
      rfcMessageId: "<fingerprint-constraint@example.test>"
    });
    const ready = await drainUntilReady(accountId, { batchSize: 1 });

    await expect(pool.query(
      `UPDATE public.imap_thread_assignments
       SET delivery_fingerprint_hashes = ARRAY['not-a-sha256']
       WHERE run_id = $1`,
      [ready.runId]
    )).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `UPDATE public.imap_thread_assignments
       SET delivery_fingerprint_hashes = DEFAULT
       WHERE run_id = $1`,
      [ready.runId]
    );
    const reset = await pool.query<{ count: string }>(
      `SELECT cardinality(delivery_fingerprint_hashes)::text AS count
       FROM public.imap_thread_assignments WHERE run_id = $1`,
      [ready.runId]
    );
    expect(reset.rows[0]?.count).toBe("0");
  });

  it("counts delivery fingerprints toward the bounded closure criteria budget", async () => {
    const accountId = await createAccount("fingerprint-criteria-budget");
    await pool.query(
      `WITH inserted AS (
         INSERT INTO public.imap_messages (
           account_id, folder_path, uidvalidity, uid, internal_date,
           subject, from_email, to_emails, rfc_message_id,
           message_id_normalized, window_status, size_bytes, headers_json
         )
         SELECT $1, 'INBOX', 101, value,
                timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second',
                'Criteria ' || value, 'sender@example.test',
                ARRAY['recipient@example.test'],
                '<criteria-' || value || '@example.test>',
                'criteria-' || value || '@example.test',
                'IN_WINDOW', 1024, '{}'::jsonb
         FROM generate_series(1, 501) AS value
         RETURNING id, uid
       )
       INSERT INTO public.imap_message_bodies (
         message_id, raw_mime, raw_mime_sha256, raw_bytes, raw_truncated, headers_json
       )
       SELECT id, NULL, lpad(to_hex(uid), 64, '0'), 1024, false, '{}'::jsonb
       FROM inserted`,
      [accountId]
    );

    let failure: unknown;
    for (let pass = 0; pass < 5 && !failure; pass += 1) {
      try {
        await repository.drainAccount(accountId, {
          batchSize: 501,
          maxClosureCriteriaKeys: 1_000,
          requestedBy: "live-test"
        });
      } catch (error) {
        failure = error;
      }
    }
    expect(failure).toMatchObject({
      name: "ThreadingEvidenceLimitError",
      kind: "criteria",
      limit: 1_000
    });
  });

  it("bounds legacy body hashing independently from the projection batch", async () => {
    const accountId = await createAccount("bounded-body-evidence");
    const rawMime = Buffer.from(
      "Message-ID: <bounded@example.test>\r\nSubject: Bounded\r\n\r\nLegacy body"
    );
    for (const uid of [1, 2]) {
      const messageId = await seedMessage(accountId, {
        uid,
        subject: "Bounded body evidence",
        fromEmail: "alice@example.test",
        toEmails: ["bob@example.test"],
        rfcMessageId: `<bounded-${uid}@example.test>`,
        rawMime,
        rawMimeSha256: null
      });
      await pool.query(
        `UPDATE public.imap_message_bodies
         SET body_text = 'Legacy body',
             headers_json = $2::jsonb
         WHERE message_id = $1`,
        [messageId, JSON.stringify({
          from: "Alice <alice@example.test>",
          to: "Bob <bob@example.test>",
          subject: "Bounded body evidence",
          "message-id": `<bounded-${uid}@example.test>`
        })]
      );
    }
    const bounded = new ThreadingRepository(pool, { bodyEvidenceBatchSize: 1 });

    const first = await bounded.drainAccount(accountId, { batchSize: 500, requestedBy: "live-test" });
    expect(first.runId).toBeNull();
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.imap_message_bodies body
       JOIN public.imap_messages message ON message.id = body.message_id
       WHERE message.account_id = $1 AND body.raw_mime_sha256 IS NOT NULL`,
      [accountId]
    )).rows[0]?.count).toBe("1");
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.imap_message_bodies body
       JOIN public.imap_messages message ON message.id = body.message_id
       WHERE message.account_id = $1 AND body.parsed_delivery_sha256 IS NOT NULL`,
      [accountId]
    )).rows[0]?.count).toBe("0");

    const second = await bounded.drainAccount(accountId, { batchSize: 500, requestedBy: "live-test" });
    expect(second.runId).toBeNull();
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.imap_message_bodies body
       JOIN public.imap_messages message ON message.id = body.message_id
       WHERE message.account_id = $1 AND body.raw_mime_sha256 IS NOT NULL`,
      [accountId]
    )).rows[0]?.count).toBe("2");

    const third = await bounded.drainAccount(accountId, { batchSize: 500, requestedBy: "live-test" });
    expect(third).toMatchObject({ runStatus: "building", stage: "strong" });
  });

  it("releases a blocked legacy body repair at its dedicated statement deadline", async () => {
    const accountId = await createAccount("body-evidence-deadline");
    const messageId = await seedMessage(accountId, {
      uid: 1,
      subject: "Body evidence deadline",
      rfcMessageId: "<body-evidence-deadline@example.test>",
      rawMime: Buffer.from("Message-ID: <body-evidence-deadline@example.test>\r\n\r\nBlocked"),
      rawMimeSha256: null
    });
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT message_id FROM public.imap_message_bodies WHERE message_id = $1 FOR UPDATE",
        [messageId]
      );
      const bounded = new ThreadingRepository(pool, {
        bodyEvidenceBatchSize: 1,
        bodyEvidenceStatementTimeoutMs: 100
      });
      const startedAt = performance.now();

      await expect(bounded.drainAccount(accountId, { batchSize: 500, requestedBy: "live-test" }))
        .rejects.toThrow(/statement timeout|canceling statement/);
      expect(performance.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("uses exact parsed-only delivery evidence without merging reused Message-IDs", async () => {
    const accountId = await createAccount("parsed-only-delivery-evidence");
    const messageIds: string[] = [];
    for (const [index, bodyText] of ["Same parsed delivery", "Same parsed delivery", "Different delivery"].entries()) {
      messageIds.push(await seedMessage(accountId, {
        uid: index + 1,
        folder: index === 1 ? "Archive" : "INBOX",
        subject: "Parsed-only copy",
        fromEmail: "alice@example.test",
        toEmails: ["bob@example.test"],
        rfcMessageId: "<parsed-copy@example.test>"
      }));
      await pool.query(
        `INSERT INTO public.imap_message_bodies (
           message_id, raw_mime, raw_mime_sha256, raw_bytes, raw_truncated,
           body_text, body_plain, selected_text_part, selected_text_format,
           headers_json, mime_structure, parser_warnings
         ) VALUES (
           $1, NULL, NULL, $2, false,
           $3, $3, $3, 'plain',
           $4::jsonb, '{"type":"text/plain"}'::jsonb, '{}'::text[]
         )`,
        [
          messageIds[index],
          Buffer.byteLength(bodyText),
          bodyText,
          JSON.stringify({
            from: "Alice <alice@example.test>",
            to: "Bob <bob@example.test>",
            subject: "Parsed-only copy",
            "message-id": "<parsed-copy@example.test>"
          })
        ]
      );
    }

    const ready = await drainUntilReady(accountId, { batchSize: 2 });
    const rows = await projection(ready.runId as string);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.delivery_key).toBe(rows[1]?.delivery_key);
    expect(rows[2]?.delivery_key).not.toBe(rows[0]?.delivery_key);

    const evidence = await pool.query<{ parsed_delivery_sha256: string | null }>(
      `SELECT parsed_delivery_sha256
       FROM public.imap_message_bodies
       WHERE message_id = ANY($1::uuid[])
       ORDER BY message_id`,
      [messageIds]
    );
    expect(evidence.rows.every((row) => row.parsed_delivery_sha256 !== null)).toBe(true);
    expect(new Set(evidence.rows.map((row) => row.parsed_delivery_sha256)).size).toBe(2);
  });

  it("collapses a raw-backed copy with a parsed-only mirror through targeted authored evidence", async () => {
    const accountId = await createAccount("cross-tier-delivery-copy");
    const messageIds: string[] = [];
    for (const [index, rawDigest] of ["d".repeat(64), null].entries()) {
      const messageId = await seedMessage(accountId, {
        uid: index + 1,
        folder: index === 0 ? "INBOX" : "INBOX.INBOX",
        subject: "Cross-tier mirror",
        fromEmail: "alice@example.test",
        toEmails: ["bob@example.test"],
        rfcMessageId: "<cross-tier-mirror@example.test>"
      });
      messageIds.push(messageId);
      await pool.query(
        `INSERT INTO public.imap_message_bodies (
           message_id, raw_mime, raw_mime_sha256, raw_bytes, raw_truncated,
           body_text, body_plain, selected_text_part, selected_text_format,
           headers_json, mime_structure, parser_warnings,
           structured_evidence_extractor_version, structured_evidence_sha256,
           structured_evidence_complete, structured_evidence_extracted_at
         ) VALUES (
           $1, NULL, $2, 128, false,
           'Exact mirror body', 'Exact mirror body', 'Exact mirror body', 'plain',
           $3::jsonb, '{"type":"text/plain"}'::jsonb, '{}'::text[],
           'test-v1', $4, true, now()
         )`,
        [
          messageId,
          rawDigest,
          JSON.stringify({
            from: "Alice <alice@example.test>",
            to: "Bob <bob@example.test>",
            date: "2026-06-22T18:23:13.000Z",
            subject: "Cross-tier mirror",
            "message-id": "<cross-tier-mirror@example.test>"
          }),
          "f".repeat(64)
        ]
      );
    }

    const ready = await drainUntilReady(accountId, { batchSize: 2 });
    const rows = await projection(ready.runId as string);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.delivery_key)).size).toBe(1);
    expect((rows[0]?.evidence.collapsed_physical_ids as string[])).toHaveLength(2);
    const repaired = await pool.query<{ authored_delivery_sha256: string | null }>(
      `SELECT authored_delivery_sha256
       FROM public.imap_message_bodies
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );
    expect(repaired.rows.every((row) => row.authored_delivery_sha256 !== null)).toBe(true);
    expect(new Set(repaired.rows.map((row) => row.authored_delivery_sha256)).size).toBe(1);
  });

  it("collapses sent and received copies when only transport headers and wire sizes differ", async () => {
    const accountId = await createAccount("transport-mutated-delivery-copy");
    const messageIds: string[] = [];
    for (const [index, rawDigest] of ["a".repeat(64), "b".repeat(64)].entries()) {
      const messageId = await seedMessage(accountId, {
        uid: index + 1,
        folder: index === 0 ? "Sent" : "INBOX",
        subject: "Self-sent test",
        fromEmail: "alice@example.test",
        toEmails: ["alice@example.test"],
        rfcMessageId: "<transport-mutated@example.test>"
      });
      messageIds.push(messageId);
      await pool.query(
        `INSERT INTO public.imap_message_bodies (
           message_id, raw_mime, raw_mime_sha256, raw_bytes, raw_truncated,
           body_text, body_plain, selected_text_part, selected_text_format,
           headers_json, mime_structure, parser_warnings,
           structured_evidence_extractor_version, structured_evidence_sha256,
           structured_evidence_complete, structured_evidence_extracted_at
         ) VALUES (
           $1, NULL, $2, $3, false,
           'Same authored body', 'Same authored body', 'Same authored body', 'plain',
           $4::jsonb, $5::jsonb, '{}'::text[],
           'test-v1', $6, true, now()
         )`,
        [
          messageId,
          rawDigest,
          index === 0 ? 482 : 2_958,
          JSON.stringify({
            from: "Alice <alice@example.test>",
            to: "Alice <alice@example.test>",
            date: "2026-06-22T18:23:13.000Z",
            subject: "Self-sent test",
            "message-id": "<transport-mutated@example.test>",
            "content-type": "text/plain; charset=us-ascii",
            "mime-version": "1.0",
            "content-transfer-encoding": "7bit",
            ...(index === 0 ? {} : {
              received: ["by inbound.example.test with ESMTPS"],
              "authentication-results": "inbound.example.test; dkim=pass",
              "return-path": "<alice@example.test>"
            })
          }),
          JSON.stringify({
            size: 18,
            type: "text/plain",
            encoding: "7bit",
            parameters: { charset: "us-ascii" }
          }),
          "f".repeat(64)
        ]
      );
    }

    const ready = await drainUntilReady(accountId, { batchSize: 2 });
    const rows = await projection(ready.runId as string);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.delivery_key)).size).toBe(1);
    const evidence = await pool.query<{ authored_delivery_sha256: string | null }>(
      `SELECT authored_delivery_sha256
       FROM public.imap_message_bodies
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );
    expect(evidence.rows.every((row) => row.authored_delivery_sha256 !== null)).toBe(true);
    expect(new Set(evidence.rows.map((row) => row.authored_delivery_sha256)).size).toBe(1);
  });

  it("fails closed when protected authored evidence needs legacy repair", async () => {
    const accountId = await createAccount("protected-authored-bridge");
    const messageIds: string[] = [];
    const adapter = new OpaqueThreadingAdapter();
    for (const [index, rawDigest] of ["a".repeat(64), "b".repeat(64)].entries()) {
      const messageId = await seedMessage(accountId, {
        uid: index + 1,
        folder: index === 0 ? "Sent" : "INBOX",
        subject: "Protected authored bridge",
        fromEmail: "alice@example.test",
        toEmails: ["alice@example.test"],
        rfcMessageId: "<protected-authored-bridge@example.test>"
      });
      messageIds.push(messageId);
      await pool.query(
        `INSERT INTO public.imap_message_bodies (
           message_id, raw_mime_sha256, raw_bytes, raw_truncated,
           headers_json, mime_structure, parser_warnings,
           structured_evidence_extractor_version, structured_evidence_sha256,
           structured_evidence_complete, structured_evidence_extracted_at,
           threading_payload_sha256
         ) VALUES (
           $1, $2, 128, false, $3::jsonb,
           '{"type":"text/plain"}'::jsonb, '{}'::text[],
           'test-v1', $4, true, now(), $5
         )`,
        [
          messageId,
          rawDigest,
          JSON.stringify({
            from: "Alice <alice@example.test>",
            to: "Alice <alice@example.test>",
            date: "2026-06-22T18:23:13.000Z",
            subject: "Protected authored bridge",
            "message-id": "<protected-authored-bridge@example.test>"
          }),
          "f".repeat(64),
          "e".repeat(64)
        ]
      );
      await protectMessageInput(adapter, accountId, messageId);
      await protectBodyInput(adapter, accountId, messageId);
    }
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: adapter
    });

    await expect(drainUntilReady(
      accountId,
      { batchSize: 2 },
      protectedRepository
    )).rejects.toThrow(
      "protected metadata has incomplete authored-delivery evidence; repair it before activation"
    );
    const stored = await pool.query<{ authored_delivery_sha256: string | null }>(
      `SELECT authored_delivery_sha256
       FROM public.imap_message_bodies
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );

    expect(stored.rows.every((row) => row.authored_delivery_sha256 === null)).toBe(true);
    expect(adapter.writes.some((write) =>
      write.context.kind === "message_body"
      && typeof write.values.authored_delivery_sha256 === "string"
    )).toBe(false);
  });

  it("does not block protected rows that cannot produce authored evidence", async () => {
    const accountId = await createAccount("protected-ineligible-authored-bridge");
    const adapter = new OpaqueThreadingAdapter();
    for (const [index, rawMime] of [Buffer.from("aaa"), Buffer.from("bbb")].entries()) {
      const messageId = await seedMessage(accountId, {
        uid: index + 1,
        folder: index === 0 ? "Sent" : "INBOX",
        internalDate: "2026-06-22T18:23:13.000Z",
        subject: "Protected ineligible bridge",
        fromEmail: "alice@example.test",
        toEmails: ["alice@example.test"],
        rfcMessageId: "<protected-ineligible-bridge@example.test>",
        rawMime,
        rawTruncated: true,
        rawMimeSha256: null
      });
      await protectMessageInput(adapter, accountId, messageId);
      await protectBodyInput(adapter, accountId, messageId);
    }
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: adapter
    });

    await expect(drainUntilReady(
      accountId,
      { batchSize: 2 },
      protectedRepository
    )).resolves.toMatchObject({ runStatus: "ready", ready: true });
  });

  it("releases targeted delivery evidence work when its source becomes ineligible", async () => {
    const accountId = await createAccount("stale-authored-delivery-work");
    const messageIds: string[] = [];
    for (const [index, rawDigest] of ["1".repeat(64), "2".repeat(64)].entries()) {
      const messageId = await seedMessage(accountId, {
        uid: index + 1,
        folder: index === 0 ? "Sent" : "INBOX",
        subject: "Targeted evidence becomes unavailable",
        fromEmail: "alice@example.test",
        toEmails: ["alice@example.test"],
        rfcMessageId: "<stale-authored-work@example.test>"
      });
      messageIds.push(messageId);
      await pool.query(
        `INSERT INTO public.imap_message_bodies (
           message_id, raw_mime, raw_mime_sha256, raw_bytes, raw_truncated,
           body_text, body_plain, selected_text_part, selected_text_format,
           headers_json, mime_structure, parser_warnings,
           structured_evidence_extractor_version, structured_evidence_sha256,
           structured_evidence_complete, structured_evidence_extracted_at
         ) VALUES (
           $1, NULL, $2, 128, false,
           'Same authored body', 'Same authored body', 'Same authored body', 'plain',
           $3::jsonb, '{"type":"text/plain"}'::jsonb, '{}'::text[],
           'test-v1', $4, true, now()
         )`,
        [
          messageId,
          rawDigest,
          JSON.stringify({
            from: "Alice <alice@example.test>",
            to: "Alice <alice@example.test>",
            date: "2026-06-22T18:23:13.000Z",
            subject: "Targeted evidence becomes unavailable",
            "message-id": "<stale-authored-work@example.test>"
          }),
          "f".repeat(64)
        ]
      );
    }

    let specialWork = 0;
    for (let pass = 0; pass < 20 && specialWork === 0; pass += 1) {
      await repository.drainAccount(accountId, { batchSize: 2, requestedBy: "live-test" });
      const pending = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM public.imap_thread_work_queue
         WHERE account_id = $1 AND reason = 'delivery_evidence_bridge'`,
        [accountId]
      );
      specialWork = Number(pending.rows[0]?.count ?? 0);
    }
    expect(specialWork).toBeGreaterThan(0);

    await pool.query(
      `UPDATE public.imap_message_bodies
       SET structured_evidence_complete = false,
           structured_evidence_sha256 = NULL
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );

    const ready = await drainUntilReady(accountId, { batchSize: 2 });
    expect(await projection(ready.runId as string)).toHaveLength(2);
    const remaining = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.imap_thread_work_queue
       WHERE account_id = $1 AND reason = 'delivery_evidence_bridge'`,
      [accountId]
    );
    expect(remaining.rows[0]?.count).toBe("0");
  });

  it("rechecks retained protected delivery evidence work after eligibility changes", async () => {
    const accountId = await createAccount("retained-protected-authored-work");
    const messageIds: string[] = [];
    for (const [index, rawDigest] of ["5".repeat(64), "6".repeat(64)].entries()) {
      const messageId = await seedMessage(accountId, {
        uid: index + 1,
        folder: index === 0 ? "Sent" : "INBOX",
        subject: "Retained protected authored work",
        fromEmail: "alice@example.test",
        toEmails: ["alice@example.test"],
        rfcMessageId: "<retained-protected-authored-work@example.test>"
      });
      messageIds.push(messageId);
      await pool.query(
        `INSERT INTO public.imap_message_bodies (
           message_id, raw_mime, raw_mime_sha256, raw_bytes, raw_truncated,
           body_text, body_plain, selected_text_part, selected_text_format,
           headers_json, mime_structure, parser_warnings,
           structured_evidence_extractor_version, structured_evidence_sha256,
           structured_evidence_complete, structured_evidence_extracted_at
         ) VALUES (
           $1, NULL, $2, 128, false,
           'Same authored body', 'Same authored body', 'Same authored body', 'plain',
           $3::jsonb, '{"type":"text/plain"}'::jsonb, '{}'::text[],
           'test-v1', $4, true, now()
         )`,
        [
          messageId,
          rawDigest,
          JSON.stringify({
            from: "Alice <alice@example.test>",
            to: "Alice <alice@example.test>",
            date: "2026-06-22T18:23:13.000Z",
            subject: "Retained protected authored work",
            "message-id": "<retained-protected-authored-work@example.test>"
          }),
          "f".repeat(64)
        ]
      );
    }

    let specialWork = 0;
    for (let pass = 0; pass < 20 && specialWork === 0; pass += 1) {
      await repository.drainAccount(accountId, { batchSize: 2, requestedBy: "live-test" });
      const pending = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM public.imap_thread_work_queue
         WHERE account_id = $1 AND reason = 'delivery_evidence_bridge'`,
        [accountId]
      );
      specialWork = Number(pending.rows[0]?.count ?? 0);
    }
    expect(specialWork).toBeGreaterThan(0);

    const adapter = new OpaqueThreadingAdapter();
    for (const messageId of messageIds) {
      await protectMessageInput(adapter, accountId, messageId);
      await protectBodyInput(adapter, accountId, messageId);
    }
    const protectedRepository = new ThreadingRepository(pool, {
      metadataProtection: adapter
    });
    let protectedGapRejected = false;
    for (let pass = 0; pass < 20 && !protectedGapRejected; pass += 1) {
      try {
        await protectedRepository.drainAccount(accountId, {
          batchSize: 2,
          requestedBy: "live-test"
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          "protected metadata has incomplete authored-delivery evidence; repair it before activation"
        );
        protectedGapRejected = true;
      }
    }
    expect(protectedGapRejected).toBe(true);

    await pool.query(
      `UPDATE public.imap_message_bodies
       SET structured_evidence_complete = false,
           structured_evidence_sha256 = NULL
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );
    for (const messageId of messageIds) {
      await protectBodyInput(adapter, accountId, messageId);
    }
    await pool.query(
      `UPDATE public.imap_thread_runs
       SET available_at = now()
       WHERE account_id = $1 AND status = 'building'`,
      [accountId]
    );
    await pool.query(
      `UPDATE public.imap_thread_work_queue
       SET available_at = now()
       WHERE account_id = $1`,
      [accountId]
    );
    await expect(drainUntilReady(
      accountId,
      { batchSize: 2 },
      protectedRepository
    )).resolves.toMatchObject({ runStatus: "ready", ready: true });
  });

  it("invalidates authored delivery evidence when a stored body is replaced", async () => {
    const accountId = await createAccount("replaced-authored-body");
    const messageIds: string[] = [];
    for (const [index, rawDigest] of ["3".repeat(64), "4".repeat(64)].entries()) {
      const messageId = await seedMessage(accountId, {
        uid: index + 1,
        folder: index === 0 ? "Sent" : "INBOX",
        subject: "Replace an authored body",
        fromEmail: "alice@example.test",
        toEmails: ["alice@example.test"],
        rfcMessageId: "<replace-authored-body@example.test>"
      });
      messageIds.push(messageId);
      await pool.query(
        `INSERT INTO public.imap_message_bodies (
           message_id, raw_mime, raw_mime_sha256, raw_bytes, raw_truncated,
           body_text, body_plain, selected_text_part, selected_text_format,
           headers_json, mime_structure, parser_warnings,
           structured_evidence_extractor_version, structured_evidence_sha256,
           structured_evidence_complete, structured_evidence_extracted_at
         ) VALUES (
           $1, NULL, $2, 128, false,
           'Original authored body', 'Original authored body', 'Original authored body', 'plain',
           $3::jsonb, '{"type":"text/plain"}'::jsonb, '{}'::text[],
           'test-v1', $4, true, now()
         )`,
        [
          messageId,
          rawDigest,
          JSON.stringify({
            from: "Alice <alice@example.test>",
            to: "Alice <alice@example.test>",
            date: "2026-06-22T18:23:13.000Z",
            subject: "Replace an authored body",
            "message-id": "<replace-authored-body@example.test>",
            "content-type": "text/plain; charset=utf-8"
          }),
          "f".repeat(64)
        ]
      );
    }

    const ready = await drainUntilReady(accountId, { batchSize: 2 });
    expect(new Set((await projection(ready.runId as string)).map((row) => row.delivery_key)).size).toBe(1);

    const replacementRaw = Buffer.from(
      "Message-ID: <replace-authored-body@example.test>\r\n" +
      "Date: Mon, 22 Jun 2026 18:23:13 +0000\r\n" +
      "From: Alice <alice@example.test>\r\n" +
      "To: Alice <alice@example.test>\r\n" +
      "Subject: Replace an authored body\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n\r\n" +
      "Different authored body"
    );
    await mirror.storeBody({
      messageId: messageIds[1],
      rawMime: replacementRaw,
      rawBytes: replacementRaw.byteLength,
      rawTruncated: false,
      bodyText: "Different authored body",
      bodyHtml: null,
      bodyPlain: "Different authored body",
      selectedTextPart: "Different authored body",
      selectedTextFormat: "plain",
      headersJson: {
        "message-id": "<replace-authored-body@example.test>",
        date: "Mon, 22 Jun 2026 18:23:13 +0000",
        from: "Alice <alice@example.test>",
        to: "Alice <alice@example.test>",
        subject: "Replace an authored body",
        "content-type": "text/plain; charset=utf-8"
      },
      mimeStructure: { type: "text/plain", parameters: { charset: "utf-8" } },
      parserWarnings: [],
      evidence: []
    });
    await drainUntilIdle(accountId);

    const changed = await projection(ready.runId as string);
    expect(new Set(changed.map((row) => row.delivery_key)).size).toBe(2);
    const evidence = await pool.query<{ authored_delivery_sha256: string | null }>(
      `SELECT authored_delivery_sha256
       FROM public.imap_message_bodies
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );
    expect(evidence.rows.every((row) => row.authored_delivery_sha256 !== null)).toBe(true);
    expect(new Set(evidence.rows.map((row) => row.authored_delivery_sha256)).size).toBe(2);
  });

  it("invalidates authored delivery evidence when authored envelope metadata changes", async () => {
    const accountId = await createAccount("changed-authored-envelope");
    const messageIds: string[] = [];
    for (const [index, rawDigest] of ["5".repeat(64), "6".repeat(64)].entries()) {
      const messageId = await seedMessage(accountId, {
        uid: index + 1,
        folder: index === 0 ? "Sent" : "INBOX",
        subject: "Original envelope subject",
        fromEmail: "alice@example.test",
        toEmails: ["alice@example.test"],
        rfcMessageId: "<changed-authored-envelope@example.test>"
      });
      messageIds.push(messageId);
      await pool.query(
        `INSERT INTO public.imap_message_bodies (
           message_id, raw_mime, raw_mime_sha256, raw_bytes, raw_truncated,
           body_text, body_plain, selected_text_part, selected_text_format,
           headers_json, mime_structure, parser_warnings,
           structured_evidence_extractor_version, structured_evidence_sha256,
           structured_evidence_complete, structured_evidence_extracted_at
         ) VALUES (
           $1, NULL, $2, 128, false,
           'Same authored body', 'Same authored body', 'Same authored body', 'plain',
           $3::jsonb, '{"type":"text/plain"}'::jsonb, '{}'::text[],
           'test-v1', $4, true, now()
         )`,
        [
          messageId,
          rawDigest,
          JSON.stringify({
            from: "Alice <alice@example.test>",
            to: "Alice <alice@example.test>",
            date: "2026-06-22T18:23:13.000Z",
            subject: "Original envelope subject",
            "message-id": "<changed-authored-envelope@example.test>"
          }),
          "f".repeat(64)
        ]
      );
    }

    const ready = await drainUntilReady(accountId, { batchSize: 2 });
    expect(new Set((await projection(ready.runId as string)).map((row) => row.delivery_key)).size).toBe(1);

    await pool.query(
      "UPDATE public.imap_messages SET subject = 'Corrected envelope subject' WHERE id = $1",
      [messageIds[1]]
    );
    await drainUntilIdle(accountId);

    const changed = await projection(ready.runId as string);
    expect(new Set(changed.map((row) => row.delivery_key)).size).toBe(2);
    const evidence = await pool.query<{ authored_delivery_sha256: string | null }>(
      `SELECT authored_delivery_sha256
       FROM public.imap_message_bodies
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );
    expect(evidence.rows.every((row) => row.authored_delivery_sha256 !== null)).toBe(true);
    expect(new Set(evidence.rows.map((row) => row.authored_delivery_sha256)).size).toBe(2);
  });

  it("rechecks an exact metadata merge and splits it when authored digests disagree", async () => {
    const accountId = await createAccount("cross-tier-message-id-reuse");
    const messageIds: string[] = [];
    for (const [index, bodyText] of ["First unrelated delivery", "Second unrelated delivery"].entries()) {
      const messageId = await seedMessage(accountId, {
        uid: index + 1,
        folder: index === 0 ? "INBOX" : "Archive",
        subject: "Reused Message-ID",
        fromEmail: "alice@example.test",
        toEmails: ["bob@example.test"],
        rfcMessageId: "<reused-cross-tier@example.test>",
        // All metadata proof fields intentionally match. V3 first treats this
        // as a mirror candidate, then targeted authored evidence must veto it.
        internalDate: "2026-01-01T12:00:00.000Z"
      });
      messageIds.push(messageId);
      await pool.query(
        `INSERT INTO public.imap_message_bodies (
           message_id, raw_mime, raw_mime_sha256, raw_bytes, raw_truncated,
           body_text, body_plain, selected_text_part, selected_text_format,
           headers_json, mime_structure, parser_warnings,
           structured_evidence_extractor_version, structured_evidence_sha256,
           structured_evidence_complete, structured_evidence_extracted_at
         ) VALUES (
           $1, NULL, $2, 128, false,
           $3, $3, $3, 'plain',
           $4::jsonb, '{"type":"text/plain"}'::jsonb, '{}'::text[],
           'test-v1', $5, true, now()
         )`,
        [
          messageId,
          index === 0 ? "e".repeat(64) : null,
          bodyText,
          JSON.stringify({
            from: "Alice <alice@example.test>",
            to: "Bob <bob@example.test>",
            date: "2026-06-22T18:23:13.000Z",
            subject: "Reused Message-ID",
            "message-id": "<reused-cross-tier@example.test>"
          }),
          "f".repeat(64)
        ]
      );
    }

    const ready = await drainUntilReady(accountId, { batchSize: 2 });
    const rows = await projection(ready.runId as string);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.delivery_key)).size).toBe(2);
    const repaired = await pool.query<{ authored_delivery_sha256: string | null }>(
      `SELECT authored_delivery_sha256
       FROM public.imap_message_bodies
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );
    expect(repaired.rows.every((row) => row.authored_delivery_sha256 !== null)).toBe(true);
    expect(new Set(repaired.rows.map((row) => row.authored_delivery_sha256)).size).toBe(2);
  });

  it("does not derive a fallback delivery fingerprint when an exact raw digest exists", async () => {
    const accountId = await createAccount("raw-digest-needs-no-fallback");
    const messageId = await seedMessage(accountId, {
      uid: 1,
      subject: "Exact raw evidence",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<exact-raw@example.test>"
    });
    await pool.query(
      `INSERT INTO public.imap_message_bodies (
         message_id, raw_mime, raw_mime_sha256, raw_bytes, raw_truncated,
         body_text, body_plain, selected_text_part, selected_text_format,
         headers_json, mime_structure, parser_warnings
       ) VALUES (
         $1, NULL, $2, 128, false,
         'Exact body', 'Exact body', 'Exact body', 'plain',
         $3::jsonb, '{"type":"text/plain"}'::jsonb, '{}'::text[]
       )`,
      [
        messageId,
        "b".repeat(64),
        JSON.stringify({
          from: "Alice <alice@example.test>",
          to: "Bob <bob@example.test>",
          subject: "Exact raw evidence",
          "message-id": "<exact-raw@example.test>"
        })
      ]
    );

    await drainUntilReady(accountId, { batchSize: 1 });
    const evidence = await pool.query<{ parsed_delivery_sha256: string | null }>(
      "SELECT parsed_delivery_sha256 FROM public.imap_message_bodies WHERE message_id = $1",
      [messageId]
    );
    expect(evidence.rows[0]?.parsed_delivery_sha256).toBeNull();
  });

  it("repairs missing assignment coverage before a shadow run can become ready", async () => {
    const accountId = await createAccount("ready-coverage-repair");
    const first = await seedMessage(accountId, {
      uid: 1,
      subject: "Coverage one",
      rfcMessageId: "<coverage-one@example.test>"
    });
    await seedMessage(accountId, {
      uid: 2,
      subject: "Coverage two",
      rfcMessageId: "<coverage-two@example.test>"
    });

    let runId: string | null = null;
    for (let pass = 0; pass < 30; pass += 1) {
      const result = await repository.drainAccount(accountId, { batchSize: 1, requestedBy: "live-test" });
      runId = result.runId;
      if (result.stage === "catchup") break;
    }
    expect(runId).not.toBeNull();

    await pool.query("DELETE FROM public.imap_thread_assignments WHERE run_id = $1 AND message_id = $2", [runId, first]);
    await pool.query("DELETE FROM public.imap_thread_work_queue WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM public.imap_thread_subject_work WHERE run_id = $1", [runId]);

    const ready = await drainUntilReady(accountId, { batchSize: 1 });
    expect(ready.runId).toBe(runId);
    expect(await projection(runId as string)).toHaveLength(2);

    // A 0014 binary could already have marked the incomplete run ready. The
    // scheduler must still rediscover and repair it even with empty queues.
    await pool.query("DELETE FROM public.imap_thread_assignments WHERE run_id = $1 AND message_id = $2", [runId, first]);
    await pool.query("DELETE FROM public.imap_thread_work_queue WHERE run_id = $1", [runId]);
    await pool.query("UPDATE public.imap_thread_runs SET summary = summary - 'coverage_verified' WHERE id = $1", [runId]);
    expect(await repository.listAccountsNeedingWork()).toContain(accountId);
    await repository.drainAccount(accountId, { batchSize: 1, requestedBy: "live-test" });
    expect(await projection(runId as string)).toHaveLength(2);
    await repository.drainAccount(accountId, { batchSize: 1, requestedBy: "live-test" });
    expect(await repository.listAccountsNeedingWork()).not.toContain(accountId);
  });

  it("repairs complete bodies written by an old worker after activation and collapses the copies", async () => {
    const accountId = await createAccount("late-old-worker-body");
    const inboxCopy = await seedMessage(accountId, {
      uid: 1,
      folder: "INBOX",
      subject: "Body-only delivery identity",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<late-body-copy@example.test>"
    });
    const sentCopy = await seedMessage(accountId, {
      uid: 1,
      folder: "Sent",
      // Prevent v3's exact-metadata mirror proof from resolving this fixture;
      // the test specifically exercises late raw-MIME evidence repair.
      internalDate: "2026-01-01T12:00:01.000Z",
      subject: "Body-only delivery identity",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<late-body-copy@example.test>"
    });
    const ready = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, ready.runId as string);
    expect(new Set((await activeProjection(accountId)).map((row) => row.delivery_key)).size).toBe(2);

    // Simulate a binary from before raw_mime_sha256 existed. The database trigger
    // queues the evidence change, but only the new threading worker can derive the
    // complete MIME fingerprint.
    const rawMime = Buffer.from(
      "From: Alice <alice@example.test>\r\n" +
      "To: Bob <bob@example.test>\r\n" +
      "Message-ID: <late-body-copy@example.test>\r\n" +
      "Subject: Body-only delivery identity\r\n" +
      "\r\nSame physical delivery\r\n"
    );
    for (const messageId of [inboxCopy, sentCopy]) {
      await pool.query(
        `INSERT INTO public.imap_message_bodies (
           message_id, raw_mime, raw_bytes, raw_truncated, headers_json
         ) VALUES ($1, $2, $3, false, '{}'::jsonb)`,
        [messageId, rawMime, rawMime.byteLength]
      );
    }

    // Reproduce the legacy lock order: the old writer owns the body row before
    // its evidence-triggering UPDATE asks for the thread-state SHARE lock. The
    // threading worker must wait on the body before (not after) taking state
    // FOR UPDATE, otherwise the two sessions deadlock.
    const legacyWriter = await pool.connect();
    try {
      await legacyWriter.query("BEGIN");
      await legacyWriter.query(
        `SELECT message_id
         FROM public.imap_message_bodies
         WHERE message_id = ANY($1::uuid[])
         ORDER BY message_id
         FOR UPDATE`,
        [[inboxCopy, sentCopy]]
      );
      let drainSettled = false;
      const drain = drainRepositoryUntilIdle(repository, accountId, { batchSize: 1 })
        .finally(() => { drainSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(drainSettled).toBe(false);

      await legacyWriter.query(
        `UPDATE public.imap_message_bodies
         SET headers_json = headers_json || '{"x-legacy-writer":"observed"}'::jsonb
         WHERE message_id = ANY($1::uuid[])`,
        [[inboxCopy, sentCopy]]
      );
      await legacyWriter.query("COMMIT");
      await drain;
    } finally {
      await legacyWriter.query("ROLLBACK").catch(() => undefined);
      legacyWriter.release();
    }

    const hashes = await pool.query<{ raw_mime_sha256: string | null }>(
      `SELECT raw_mime_sha256
       FROM public.imap_message_bodies
       WHERE message_id = ANY($1::uuid[])
       ORDER BY message_id`,
      [[inboxCopy, sentCopy]]
    );
    expect(hashes.rows).toHaveLength(2);
    expect(hashes.rows.every((row) => row.raw_mime_sha256 === createHash("sha256").update(rawMime).digest("hex")))
      .toBe(true);
    expect(new Set((await activeProjection(accountId)).map((row) => row.delivery_key)).size).toBe(1);
  });

  it("fails closed with queue-local backoff before a protocol closure can exceed its bound", async () => {
    const accountId = await createAccount("closure-cap");
    const root = await seedMessage(accountId, {
      uid: 1,
      subject: "Large chain",
      rfcMessageId: "<large-root@example.test>"
    });
    await seedMessage(accountId, {
      uid: 2,
      subject: "Re: Large chain",
      rfcMessageId: "<large-reply-1@example.test>",
      inReplyTo: "<large-root@example.test>",
      referencesHeader: "<large-root@example.test>"
    });
    await seedMessage(accountId, {
      uid: 3,
      subject: "Re: Large chain",
      rfcMessageId: "<large-reply-2@example.test>",
      inReplyTo: "<large-reply-1@example.test>",
      referencesHeader: "<large-root@example.test> <large-reply-1@example.test>"
    });
    const ready = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, ready.runId as string);
    await enqueueMessage(accountId, root);

    await expect(repository.drainAccount(accountId, {
      batchSize: 1,
      maxClosureMessages: 2,
      requestedBy: "live-test"
    })).rejects.toBeInstanceOf(ThreadingClosureLimitError);

    const delayed = await pool.query<{
      attempts: number;
      failures: string;
      queue_delayed: boolean;
      run_ready: boolean;
    }>(
      `SELECT run.attempts,
              run.available_at <= now() AS run_ready,
              (SELECT bool_and(queue.available_at > now())
               FROM public.imap_thread_work_queue queue
               WHERE queue.run_id = run.id) AS queue_delayed,
              (SELECT count(*)::text FROM public.imap_thread_operations operation
               WHERE operation.run_id = run.id
                 AND operation.operation_type = 'failure'
                 AND operation.status = 'failed') AS failures
       FROM public.imap_thread_runs run WHERE run.id = $1`,
      [ready.runId]
    );
    expect(delayed.rows[0]).toEqual({
      attempts: 1,
      failures: "1",
      queue_delayed: true,
      run_ready: true
    });
    expect(await repository.listAccountsNeedingWork()).not.toContain(accountId);
  });

  it("bounds aggregate closure evidence bytes before loading a hostile header set", async () => {
    const accountId = await createAccount("evidence-byte-cap");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Evidence budget",
      rfcMessageId: "<evidence-budget@example.test>",
      headersJson: { "x-hostile-evidence": "x".repeat(4_096) }
    });

    await repository.drainAccount(accountId, {
      batchSize: 1,
      maxClosureEvidenceBytes: 1_024,
      requestedBy: "live-test"
    });
    await repository.drainAccount(accountId, {
      batchSize: 1,
      maxClosureEvidenceBytes: 1_024,
      requestedBy: "live-test"
    });
    await expect(repository.drainAccount(accountId, {
      batchSize: 1,
      maxClosureEvidenceBytes: 1_024,
      requestedBy: "live-test"
    })).rejects.toBeInstanceOf(ThreadingEvidenceLimitError);

    const failed = await pool.query<{ attempts: number; error: string | null; run_ready: boolean }>(
      `SELECT attempts, last_error AS error, available_at <= now() AS run_ready
       FROM public.imap_thread_runs WHERE account_id = $1 AND status = 'building'`,
      [accountId]
    );
    expect(failed.rows[0]?.attempts).toBe(1);
    expect(failed.rows[0]?.error).toMatch(/evidence bytes/);
    expect(failed.rows[0]?.run_ready).toBe(false);

    await expect(repository.drainAccount(accountId, {
      batchSize: 1,
      maxClosureEvidenceBytes: 1_024,
      requestedBy: "live-test"
    })).resolves.toMatchObject({ busy: true, assignmentsChanged: 0 });
    const attempts = await pool.query<{ attempts: number }>(
      `SELECT attempts FROM public.imap_thread_runs
       WHERE account_id = $1 AND status = 'building'`,
      [accountId]
    );
    expect(attempts.rows[0]?.attempts).toBe(1);
  });

  it("counts recipient evidence once when enforcing the closure byte bound", async () => {
    const accountId = await createAccount("recipient-evidence-accounting");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Recipient evidence accounting",
      toEmails: [`${"r".repeat(700)}@example.test`],
      rfcMessageId: "<recipient-evidence-accounting@example.test>"
    });

    let strong: ThreadingRunResult | null = null;
    for (let pass = 0; pass < 10; pass += 1) {
      strong = await repository.drainAccount(accountId, {
        batchSize: 1,
        maxClosureEvidenceBytes: 1_024,
        requestedBy: "live-test"
      });
      if (strong.stage === "strong") break;
    }
    await expect(repository.drainAccount(accountId, {
      batchSize: 1,
      maxClosureEvidenceBytes: 1_024,
      requestedBy: "live-test"
    })).resolves.toMatchObject({ runId: strong?.runId, assignmentsChanged: 1 });
  });

  it("subdivides a retry page when only the aggregate evidence exceeds the bound", async () => {
    const accountId = await createAccount("adaptive-evidence-page");
    for (let uid = 1; uid <= 4; uid += 1) {
      await seedMessage(accountId, {
        uid,
        subject: `Independent evidence ${uid}`,
        rfcMessageId: `<adaptive-evidence-${uid}@example.test>`,
        headersJson: { "x-bounded-evidence": "x".repeat(350) }
      });
    }

    let runId: string | null = null;
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await repository.drainAccount(accountId, {
        batchSize: 4,
        maxClosureEvidenceBytes: 1_024,
        requestedBy: "live-test"
      });
      runId = result.runId;
      if (result.stage === "strong") break;
    }
    expect(runId).not.toBeNull();
    await pool.query("UPDATE public.imap_thread_runs SET attempts = 8 WHERE id = $1", [runId]);
    await expect(repository.drainAccount(accountId, {
      batchSize: 4,
      maxClosureEvidenceBytes: 1_024,
      requestedBy: "live-test"
    })).rejects.toBeInstanceOf(ThreadingEvidenceLimitError);

    const adaptive = await pool.query<{
      attempts: number;
      batch_size: string | null;
      max_queue_delay_seconds: number;
      run_ready: boolean;
    }>(
      `SELECT attempts,
              summary->>'adaptive_closure_batch_size' AS batch_size,
              available_at <= now() AS run_ready,
              (SELECT max(extract(epoch FROM queue.available_at - now()))::double precision
               FROM public.imap_thread_work_queue queue
               WHERE queue.run_id = run.id) AS max_queue_delay_seconds
       FROM public.imap_thread_runs run WHERE run.id = $1`,
      [runId]
    );
    expect(adaptive.rows[0]).toMatchObject({ attempts: 9, batch_size: "2" });
    expect(adaptive.rows[0]?.run_ready).toBe(true);
    expect(adaptive.rows[0]?.max_queue_delay_seconds).toBeGreaterThan(0);
    expect(adaptive.rows[0]?.max_queue_delay_seconds).toBeLessThanOrEqual(5);

    await pool.query("UPDATE public.imap_thread_runs SET available_at = now() WHERE id = $1", [runId]);
    await pool.query("UPDATE public.imap_thread_work_queue SET available_at = now() WHERE run_id = $1", [runId]);
    let ready: ThreadingRunResult | null = null;
    for (let pass = 0; pass < 30; pass += 1) {
      ready = await repository.drainAccount(accountId, {
        batchSize: 4,
        maxClosureEvidenceBytes: 1_024,
        requestedBy: "live-test"
      });
      if (ready.ready && ready.runStatus === "ready") break;
    }
    expect(ready).toMatchObject({ runId, runStatus: "ready", ready: true });
    expect(await projection(runId as string)).toHaveLength(4);
  });

  it("subdivides a production-shaped statement timeout until the queue makes progress", async () => {
    const accountId = await createAccount("timeout-stage-repro");
    await pool.query(
      `WITH generated AS (
         SELECT sequence,
                ((sequence - 1) / 9)::integer AS component,
                ((sequence - 1) % 9)::integer AS position
         FROM generate_series(1, 990) AS sequence
       )
       INSERT INTO public.imap_messages (
         account_id, folder_path, uidvalidity, uid, internal_date,
         subject, from_email, to_emails,
         rfc_message_id, message_id_normalized,
         provider_thread_id, provider_thread_id_namespace,
         window_status, size_bytes, headers_json
       )
       SELECT $1, 'INBOX', 101, sequence, '2026-08-15T00:00:00.000Z',
              format('Synthetic component %s message %s', component, position),
              'sender@example.test', ARRAY['recipient@example.test'],
              format('<timeout-%s-%s@example.test>', component, position),
              format('timeout-%s-%s@example.test', component, position),
              format('timeout-component-%s', component), 'fixture',
              'IN_WINDOW', 1024, '{}'::jsonb
       FROM generated`,
      [accountId]
    );

    const ready = await drainUntilReady(accountId, { batchSize: 500 });
    await activateReviewed(repository, accountId, ready.runId as string);
    const changed = await pool.query<{ id: string }>(
      `WITH ranked AS (
         SELECT id, provider_thread_id,
                row_number() OVER (PARTITION BY provider_thread_id ORDER BY id) AS position
         FROM public.imap_messages
         WHERE account_id = $1
       )
       UPDATE public.imap_messages message
       SET provider_thread_id = message.provider_thread_id || '-changed'
       FROM ranked
       WHERE message.id = ranked.id
         AND (ranked.position <= 3 OR (ranked.provider_thread_id = 'timeout-component-0' AND ranked.position = 4))
       RETURNING message.id`,
      [accountId]
    );
    expect(changed.rows).toHaveLength(331);

    const timedPool = createPool({
      DATABASE_URL: process.env.DATABASE_URL as string,
      DATABASE_POOL_MAX: 1
    });
    const timings: Array<{
      stage: string;
      outcome: string;
      elapsedMs: number;
      itemCount?: number;
      iteration?: number;
    }> = [];
    const timedRepository = new ThreadingRepository(timedPool, {
      projectionStatementTimeoutMs: 30,
      onStageTiming: async (timing) => {
        timings.push(timing);
        throw new Error("telemetry sink unavailable");
      }
    });
    let firstFailure: unknown;
    try {
      await timedRepository.drainAccount(accountId, {
        batchSize: 500,
        requestedBy: "live-test"
      });
    } catch (error) {
      firstFailure = error;
    }
    expect(isThreadingStatementTimeout(firstFailure)).toBe(true);

    const failedStage = timings.find((timing) => timing.outcome === "failed");
    expect([
      "assignment_state_load",
      "assignment_upsert",
      "assignment_history_write"
    ]).toContain(failedStage?.stage);
    console.info(JSON.stringify({
      event: "threading.timeout_stage",
      stage: failedStage?.stage,
      durationMs: Math.round(failedStage?.elapsedMs ?? 0),
      itemCount: failedStage?.itemCount
    }));
    expect(timings.every((timing) => Object.keys(timing).every((key) => [
      "stage",
      "outcome",
      "elapsedMs",
      "itemCount",
      "iteration"
    ].includes(key)))).toBe(true);

    const failure = await pool.query<{
      attempted: string;
      adaptive_batch_size: string | null;
      error_code: string | null;
      queued: string;
      retry_state: string | null;
    }>(
      `SELECT operation.summary->>'messages_attempted' AS attempted,
              operation.summary->>'adaptive_retry_batch_size' AS adaptive_batch_size,
              operation.summary->>'error_code' AS error_code,
              (SELECT count(*)::text FROM public.imap_thread_work_queue queue
               WHERE queue.run_id = operation.run_id) AS queued,
              operation.summary->>'retry_state' AS retry_state
       FROM public.imap_thread_operations operation
       WHERE operation.run_id = $1 AND operation.operation_type = 'failure'
       ORDER BY operation.completed_at DESC
       LIMIT 1`,
      [ready.runId]
    );
    expect(failure.rows[0]).toEqual({
      attempted: "331",
      adaptive_batch_size: "165",
      error_code: "statement_timeout",
      queued: "331",
      retry_state: "subdivided"
    });

    let queueItemsProcessed = 0;
    try {
      for (let pass = 0; pass < 40; pass += 1) {
        await pool.query(
          "UPDATE public.imap_thread_runs SET available_at = now() WHERE id = $1",
          [ready.runId]
        );
        await pool.query(
          "UPDATE public.imap_thread_work_queue SET available_at = now() WHERE run_id = $1",
          [ready.runId]
        );
        try {
          const result = await timedRepository.drainAccount(accountId, {
            batchSize: 500,
            requestedBy: "live-test"
          });
          queueItemsProcessed += result.queueItemsProcessed;
        } catch (error) {
          expect(isThreadingStatementTimeout(error)).toBe(true);
        }
        const queued = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM public.imap_thread_work_queue WHERE run_id = $1",
          [ready.runId]
        );
        if (queued.rows[0]?.count === "0") break;
      }
    } finally {
      await timedPool.end();
    }

    const remaining = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.imap_thread_work_queue WHERE run_id = $1",
      [ready.runId]
    );
    const selectedPageSizes = timings
      .filter((timing) => timing.stage === "queue_selection" && timing.outcome === "succeeded")
      .map((timing) => timing.itemCount);
    expect(selectedPageSizes.slice(0, 2)).toEqual([331, 165]);
    expect(queueItemsProcessed).toBeGreaterThan(0);
    expect(remaining.rows[0]?.count).toBe("0");
  }, 180_000);

  it("isolates and alerts on one irreducible timeout while later work advances", async () => {
    const accountId = await createAccount("irreducible-timeout");
    const poisonId = await seedMessage(accountId, {
      uid: 1,
      subject: "Poison",
      rfcMessageId: "<poison@example.test>",
      providerMessageId: "poison",
      providerMessageNamespace: "fixture"
    });
    const healthyIds = await Promise.all([2, 3].map((uid) => seedMessage(accountId, {
      uid,
      subject: `Healthy ${uid}`,
      rfcMessageId: `<healthy-${uid}@example.test>`,
      providerMessageId: `healthy-${uid}`,
      providerMessageNamespace: "fixture"
    })));
    const ready = await drainUntilReady(accountId, { batchSize: 3 });
    await activateReviewed(repository, accountId, ready.runId as string);

    const timeoutExecutor = (inputs: Parameters<typeof computeThreadAssignments>[0]) => {
      if (inputs.some((input) => input.provider_message_id === "poison")) {
        throw Object.assign(
          new Error("canceling statement due to statement timeout"),
          { code: "57014" }
        );
      }
      return computeThreadAssignments(inputs);
    };
    const faultRepository = new ThreadingRepository(pool, {
      algorithms: new Map([
        [1, computeThreadAssignmentsV1],
        [2, computeThreadAssignmentsV2],
        [3, timeoutExecutor]
      ])
    });
    await Promise.all([poisonId, ...healthyIds].map((id) => enqueueMessage(accountId, id)));
    await pool.query(
      `UPDATE public.imap_thread_work_queue queue
       SET enqueued_at = ordering.enqueued_at
       FROM (VALUES
         ($1::uuid, now() - interval '3 minutes'),
         ($2::uuid, now() - interval '2 minutes'),
         ($3::uuid, now() - interval '1 minute')
       ) AS ordering(message_id, enqueued_at)
       WHERE queue.run_id = $4 AND queue.message_id = ordering.message_id`,
      [poisonId, healthyIds[0], healthyIds[1], ready.runId]
    );

    await expect(faultRepository.drainAccount(accountId, {
      batchSize: 3,
      requestedBy: "live-test"
    })).rejects.toMatchObject({
      code: "57014",
      message: expect.stringContaining("statement timeout")
    });
    await pool.query(
      "UPDATE public.imap_thread_runs SET available_at = now() WHERE id = $1",
      [ready.runId]
    );
    await pool.query(
      "UPDATE public.imap_thread_work_queue SET available_at = now() WHERE run_id = $1",
      [ready.runId]
    );
    await expect(faultRepository.drainAccount(accountId, {
      batchSize: 3,
      requestedBy: "live-test"
    })).rejects.toMatchObject({
      code: "57014",
      message: expect.stringContaining("statement timeout")
    });

    for (const healthyId of healthyIds) {
      const result = await faultRepository.drainAccount(accountId, {
        batchSize: 3,
        requestedBy: "live-test"
      });
      expect(result.queueItemsProcessed).toBe(1);
      const queued = await pool.query<{ queued: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM public.imap_thread_work_queue
           WHERE run_id = $1 AND message_id = $2
         ) AS queued`,
        [ready.runId, healthyId]
      );
      expect(queued.rows[0]?.queued).toBe(false);
    }

    for (let attempt = 2; attempt < 10; attempt += 1) {
      await pool.query(
        "UPDATE public.imap_thread_runs SET available_at = now() WHERE id = $1",
        [ready.runId]
      );
      await pool.query(
        "UPDATE public.imap_thread_work_queue SET available_at = now() WHERE run_id = $1 AND message_id = $2",
        [ready.runId, poisonId]
      );
      await expect(faultRepository.drainAccount(accountId, {
        batchSize: 3,
        requestedBy: "live-test"
      })).rejects.toMatchObject({
        code: "57014",
        message: expect.stringContaining("statement timeout")
      });
    }

    const isolated = await pool.query<{
      attempts: number;
      reason: string;
      retry_state: string | null;
    }>(
      `SELECT queue.attempts, queue.reason,
              operation.summary->>'retry_state' AS retry_state
       FROM public.imap_thread_work_queue queue
       JOIN LATERAL (
         SELECT summary
         FROM public.imap_thread_operations operation
         WHERE operation.run_id = queue.run_id
           AND operation.operation_type = 'failure'
         ORDER BY operation.completed_at DESC
         LIMIT 1
       ) operation ON true
       WHERE queue.run_id = $1 AND queue.message_id = $2`,
      [ready.runId, poisonId]
    );
    expect(isolated.rows[0]).toEqual({
      attempts: 10,
      reason: "threading_retry_alert",
      retry_state: "irreducible_item"
    });

    const newHealthyId = await seedMessage(accountId, {
      uid: 4,
      subject: "New healthy work",
      rfcMessageId: "<healthy-4@example.test>",
      providerMessageId: "healthy-4",
      providerMessageNamespace: "fixture"
    });
    await enqueueMessage(accountId, newHealthyId);
    const progressed = await faultRepository.drainAccount(accountId, {
      batchSize: 3,
      requestedBy: "live-test"
    });
    expect(progressed.queueItemsProcessed).toBe(1);
    const retained = await pool.query<{ ids: string[] }>(
      `SELECT array_agg(message_id::text ORDER BY message_id)::text[] AS ids
       FROM public.imap_thread_work_queue WHERE run_id = $1`,
      [ready.runId]
    );
    expect(retained.rows[0]?.ids).toEqual([poisonId]);
  });

  it("accepts a measured 17 MiB production-sized evidence page under the default bound", async () => {
    const accountId = await createAccount("production-evidence-page");
    const evidence = "x".repeat(1_044_000);
    for (let uid = 1; uid <= 17; uid += 1) {
      await seedMessage(accountId, {
        uid,
        subject: `Production evidence ${uid}`,
        rfcMessageId: `<production-evidence-${uid}@example.test>`,
        headersJson: { "x-production-evidence": evidence }
      });
    }

    await repository.drainAccount(accountId, { batchSize: 17, requestedBy: "live-test" });
    await repository.drainAccount(accountId, { batchSize: 17, requestedBy: "live-test" });
    await expect(repository.drainAccount(accountId, {
      batchSize: 17,
      requestedBy: "live-test"
    })).resolves.toMatchObject({ messagesConsidered: 17, assignmentsChanged: 17 });
  });

  it("lets an older rolling-deploy worker observe but never mutate a newer active run", async () => {
    const accountId = await createAccount("version-skew");
    const newer = await pool.query<{ id: string }>(
      `INSERT INTO public.imap_thread_runs (
         account_id, algorithm_version, mode, status, stage,
         completed_at, activated_at, requested_by, reason
       ) VALUES ($1, 4, 'initial', 'active', 'ready', now(), now(), 'live-test', 'future worker')
       RETURNING id`,
      [accountId]
    );
    await pool.query(
      `INSERT INTO public.imap_thread_state (account_id, active_run_id)
       VALUES ($1, $2)`,
      [accountId, newer.rows[0].id]
    );

    await expect(repository.drainAccount(accountId, { requestedBy: "old-worker" }))
      .rejects.toBeInstanceOf(ThreadingVersionSkewError);
    const untouched = await pool.query<{ attempts: number; operations: string }>(
      `SELECT run.attempts,
              (SELECT count(*)::text FROM public.imap_thread_operations operation
               WHERE operation.run_id = run.id) AS operations
       FROM public.imap_thread_runs run WHERE run.id = $1`,
      [newer.rows[0].id]
    );
    expect(untouched.rows[0]).toEqual({ attempts: 0, operations: "0" });
    await expect(repository.listAccountsNeedingWork())
      .rejects.toThrow(/active.*v4.*no retained executor/i);
  });

  it("quantifies shadow-run merge disagreements before activation", async () => {
    const accountId = await createAccount("shadow-comparison");
    await seedMessage(accountId, {
      uid: 1,
      subject: "First",
      rfcMessageId: "<comparison-first@example.test>"
    });
    await seedMessage(accountId, {
      uid: 2,
      subject: "Second",
      rfcMessageId: "<comparison-second@example.test>"
    });
    const baseline = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, baseline.runId as string);

    const candidate = await repository.rebuildAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test",
      reason: "compare provider evidence"
    });
    // Model a candidate-only merge without mutating immutable source evidence or
    // dirtying the active baseline. The comparison certificate must quantify it
    // and fail its default zero-merge gate.
    await pool.query(
      `UPDATE public.imap_thread_assignments candidate_assignment
       SET conversation_id = (
             SELECT baseline_assignment.conversation_id
             FROM public.imap_thread_assignments baseline_assignment
             WHERE baseline_assignment.run_id = $1
             ORDER BY baseline_assignment.message_id
             LIMIT 1
           ),
           assignment_method = 'provider_thread',
           confidence = 'medium',
           is_provisional = false
       WHERE candidate_assignment.run_id = $2`,
      [baseline.runId, candidate.runId]
    );
    const comparison = await repository.compareRuns(
      accountId,
      baseline.runId as string,
      candidate.runId as string,
      10
    );

    expect(comparison).toMatchObject({
      baselineAssignments: 2,
      candidateAssignments: 2,
      changedAssignments: 2,
      baselineConversations: 2,
      candidateConversations: 1,
      conversationMerges: { groups: 1, messages: 2 },
      conversationSplits: { groups: 0, messages: 0 },
      passed: false
    });
    expect(comparison.samples).toHaveLength(2);
    await expect(repository.activateRun(accountId, candidate.runId as string, {
      requestedBy: "live-test",
      comparisonId: comparison.comparisonId
    })).rejects.toThrow(/did not pass/);
    expect((await activeProjection(accountId)).every((row) => row.run_id === baseline.runId)).toBe(true);
  });

  it("keeps a same-version standby caught up so rollout rollback survives new mail", async () => {
    const accountId = await createAccount("standby-catchup");
    const root = await seedMessage(accountId, {
      uid: 1,
      subject: "Rollout",
      rfcMessageId: "<rollout-root@example.test>"
    });
    const baseline = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, baseline.runId as string);

    await pool.query(
      "UPDATE public.imap_messages SET subject = 'Rollout evidence' WHERE id = $1",
      [root]
    );
    await drainUntilIdle(accountId);
    const historyBeforeActivation = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.imap_thread_assignment_history
       WHERE account_id = $1`,
      [accountId]
    );
    expect(Number(historyBeforeActivation.rows[0]?.count)).toBeGreaterThan(0);

    const candidate = await repository.rebuildAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test",
      reason: "same-version rollout"
    });
    const activation = await activateReviewed(repository, accountId, candidate.runId as string);
    const historyAfterActivation = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.imap_thread_assignment_history
       WHERE account_id = $1`,
      [accountId]
    );
    expect(historyAfterActivation.rows[0]?.count).toBe("0");

    const reply = await seedMessage(accountId, {
      uid: 2,
      subject: "Re: Rollout",
      rfcMessageId: "<rollout-reply@example.test>",
      inReplyTo: "<rollout-root@example.test>",
      referencesHeader: "<rollout-root@example.test>"
    });
    await enqueueMessage(accountId, reply);
    await drainUntilIdle(accountId);

    const counts = await pool.query<{ run_id: string; assignments: string }>(
      `SELECT run.id AS run_id, count(assignment.message_id)::text AS assignments
       FROM public.imap_thread_runs run
       LEFT JOIN public.imap_thread_assignments assignment ON assignment.run_id = run.id
       WHERE run.id = ANY($1::uuid[])
       GROUP BY run.id ORDER BY run.id`,
      [[baseline.runId, candidate.runId]]
    );
    expect(counts.rows.every((row) => row.assignments === "2")).toBe(true);

    const liveHistory = await pool.query<{ run_id: string }>(
      `SELECT DISTINCT run_id
       FROM public.imap_thread_assignment_history
       WHERE account_id = $1`,
      [accountId]
    );
    expect(liveHistory.rows).toEqual([{ run_id: candidate.runId as string }]);

    await repository.rollbackOperation(accountId, activation.operationId as string, "live-test");
    const active = await activeProjection(accountId);
    expect(active).toHaveLength(2);
    expect(active.every((row) => row.run_id === baseline.runId)).toBe(true);
    const historyAfterRollback = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.imap_thread_assignment_history
       WHERE account_id = $1`,
      [accountId]
    );
    expect(historyAfterRollback.rows[0]?.count).toBe("0");
  });

  it("dissolves an old weak subject merge when the bucket later exceeds its safety cap", async () => {
    const accountId = await createAccount("subject-overflow-invalidation");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Status",
      fromEmail: "alice@example.test",
      toEmails: ["bob@example.test"],
      rfcMessageId: "<status-a@example.test>",
      internalDate: "2026-04-01T12:00:00.000Z"
    });
    await seedMessage(accountId, {
      uid: 2,
      subject: "Re: Status",
      fromEmail: "bob@example.test",
      toEmails: ["alice@example.test"],
      rfcMessageId: "<status-b@example.test>",
      internalDate: "2026-04-02T12:00:00.000Z"
    });
    const baseline = await drainUntilReady(accountId, {
      batchSize: 1,
      maxSubjectBucketMessages: 2
    });
    await activateReviewed(repository, accountId, baseline.runId as string);
    expect(new Set((await activeProjection(accountId)).map((row) => row.conversation_id)).size).toBe(1);

    const ambiguous = await seedMessage(accountId, {
      uid: 3,
      subject: "Status",
      fromEmail: "carol@example.test",
      toEmails: ["dave@example.test"],
      rfcMessageId: "<status-c@example.test>",
      internalDate: "2026-04-03T12:00:00.000Z"
    });
    await enqueueMessage(accountId, ambiguous);
    await drainRepositoryUntilIdle(repository, accountId, {
      batchSize: 1,
      maxSubjectBucketMessages: 2
    });

    const rows = await activeProjection(accountId);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.conversation_id)).size).toBe(3);
    expect(rows.every((row) => row.assignment_method === "standalone")).toBe(true);
  });

  it("does not let an idle ready candidate starve the rollback standby", async () => {
    const accountId = await createAccount("standby-candidate-fairness");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Fair rollout",
      rfcMessageId: "<fair-root@example.test>"
    });
    const first = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, first.runId as string);
    const second = await repository.rebuildAccount(accountId, { batchSize: 1, requestedBy: "live-test" });
    await activateReviewed(repository, accountId, second.runId as string);
    const third = await repository.rebuildAccount(accountId, { batchSize: 1, requestedBy: "live-test" });
    expect(third.runStatus).toBe("ready");

    const reply = await seedMessage(accountId, {
      uid: 2,
      subject: "Re: Fair rollout",
      rfcMessageId: "<fair-reply@example.test>",
      inReplyTo: "<fair-root@example.test>",
      referencesHeader: "<fair-root@example.test>"
    });
    await enqueueMessage(accountId, reply);
    await drainRepositoryUntilIdle(repository, accountId, { batchSize: 1 });

    const remaining = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.imap_thread_work_queue queue
       JOIN public.imap_thread_state state ON state.previous_run_id = queue.run_id
       WHERE state.account_id = $1`,
      [accountId]
    );
    expect(remaining.rows[0]?.count).toBe("0");
    expect(await projection(first.runId as string)).toHaveLength(2);
  });

  it("persists weighted fairness so active ingress cannot starve a shadow build", async () => {
    const accountId = await createAccount("persistent-run-fairness");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Fair scheduler",
      rfcMessageId: "<fair-scheduler-root@example.test>"
    });
    const active = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, active.runId as string);
    const candidateRunId = await repository.startRebuild(accountId, {
      requestedBy: "live-test",
      reason: "fairness under sustained active work"
    });

    for (let uid = 2; uid <= 21; uid += 1) {
      await seedMessage(accountId, {
        uid,
        subject: `Independent ${uid}`,
        rfcMessageId: `<fair-scheduler-${uid}@example.test>`
      });
    }

    // Recreate the repository on every pass: fairness must survive workers and
    // deploys rather than depending on an in-memory round-robin counter.
    for (let pass = 0; pass < 10; pass += 1) {
      await new ThreadingRepository(pool).drainAccount(accountId, {
        batchSize: 1,
        requestedBy: "live-test"
      });
    }

    const progress = await pool.query<{
      cursor_message_id: string | null;
      stage: string;
      active_work: string;
    }>(
      `SELECT candidate.cursor_message_id::text, candidate.stage,
              (SELECT count(*)::text FROM public.imap_thread_work_queue queue
               WHERE queue.run_id = state.active_run_id) AS active_work
       FROM public.imap_thread_state state
       JOIN public.imap_thread_runs candidate ON candidate.id = state.building_run_id
       WHERE state.account_id = $1 AND candidate.id = $2`,
      [accountId, candidateRunId]
    );
    expect(Number(progress.rows[0]?.active_work)).toBeGreaterThan(0);
    expect(progress.rows[0]?.cursor_message_id !== null || progress.rows[0]?.stage !== "body_evidence").toBe(true);
  });

  it("routes active, candidate, and rollback work through retained version executors", async () => {
    const accountId = await createAccount("cross-version-routing");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Versioned rollout",
      rfcMessageId: "<version-root@example.test>"
    });
    const v2Repository = new ThreadingRepository(pool, {
      currentAlgorithmVersion: 2,
      algorithms: new Map([[1, executorFor(1)], [2, executorFor(2)]])
    });
    const v2 = await drainUntilReady(accountId, { batchSize: 1 }, v2Repository);
    await activateReviewed(v2Repository, accountId, v2.runId as string);

    const v3Repository = new ThreadingRepository(pool, {
      currentAlgorithmVersion: 3,
      algorithms: new Map([
        [2, executorFor(2)],
        [3, executorFor(3)]
      ])
    });
    const v3RunId = await v3Repository.startRebuild(accountId, {
      batchSize: 1,
      requestedBy: "v3-worker",
      reason: "v3 shadow"
    });

    const duringBuild = await seedMessage(accountId, {
      uid: 2,
      subject: "Re: Versioned rollout",
      rfcMessageId: "<version-build-reply@example.test>",
      inReplyTo: "<version-root@example.test>",
      referencesHeader: "<version-root@example.test>"
    });
    await enqueueMessage(accountId, duringBuild);
    for (let pass = 0; pass < 100; pass += 1) {
      await v3Repository.drainAccount(accountId, { batchSize: 1, requestedBy: "v3-worker" });
      const status = await v3Repository.getRun(v3RunId);
      if (status.status === "ready") break;
    }
    expect((await v3Repository.getRun(v3RunId)).status).toBe("ready");
    expect(await projection(v2.runId as string)).toHaveLength(2);

    const activation = await activateReviewed(v3Repository, accountId, v3RunId, "v3-worker");
    const afterActivation = await seedMessage(accountId, {
      uid: 3,
      subject: "Re: Versioned rollout",
      rfcMessageId: "<version-live-reply@example.test>",
      inReplyTo: "<version-build-reply@example.test>",
      referencesHeader: "<version-root@example.test> <version-build-reply@example.test>"
    });
    await enqueueMessage(accountId, afterActivation);
    await drainRepositoryUntilIdle(v3Repository, accountId, { batchSize: 1 });
    expect(await projection(v2.runId as string)).toHaveLength(3);
    expect(await projection(v3RunId)).toHaveLength(3);

    await v3Repository.rollbackOperation(accountId, activation.operationId as string, "live-test");
    const active = await activeProjection(accountId);
    expect(active).toHaveLength(3);
    expect(active.every((row) => row.run_id === v2.runId)).toBe(true);
  });

  it("fails rollout compatibility when a state-referenced run has no retained executor", async () => {
    const accountId = await createAccount("missing-retained-executor");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Retained executor",
      rfcMessageId: "<retained-executor@example.test>"
    });
    const v2Repository = new ThreadingRepository(pool, {
      currentAlgorithmVersion: 2,
      algorithms: new Map([[1, executorFor(1)], [2, executorFor(2)]])
    });
    const v2 = await drainUntilReady(accountId, { batchSize: 1 }, v2Repository);
    await activateReviewed(v2Repository, accountId, v2.runId as string);

    const unsafeV3Repository = new ThreadingRepository(pool, {
      currentAlgorithmVersion: 3,
      algorithms: new Map([[3, executorFor(3)]])
    });
    await expect(unsafeV3Repository.assertRolloutCompatibility())
      .rejects.toThrow(/active.*v2.*no retained executor/i);
    await expect(unsafeV3Repository.startRebuild(accountId, { requestedBy: "unsafe-v3-cli" }))
      .rejects.toThrow(/active.*v2.*no retained executor/i);
    await expect(unsafeV3Repository.drainAccount(accountId, { requestedBy: "unsafe-v3-cli" }))
      .rejects.toThrow(/active.*v2.*no retained executor/i);

    const safeV3Repository = new ThreadingRepository(pool, {
      currentAlgorithmVersion: 3,
      algorithms: new Map([[2, executorFor(2)], [3, executorFor(3)]])
    });
    await expect(safeV3Repository.assertRolloutCompatibility()).resolves.toBeUndefined();
  });

  it("refuses to let an older binary supersede a newer shadow candidate", async () => {
    const accountId = await createAccount("old-rebuild-guard");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Upgrade guard",
      rfcMessageId: "<upgrade-guard@example.test>"
    });
    const v2Repository = new ThreadingRepository(pool, {
      currentAlgorithmVersion: 2,
      algorithms: new Map([[1, executorFor(1)], [2, executorFor(2)]])
    });
    const baseline = await drainUntilReady(accountId, { batchSize: 1 }, v2Repository);
    await activateReviewed(v2Repository, accountId, baseline.runId as string);
    const v3Repository = new ThreadingRepository(pool, {
      currentAlgorithmVersion: 3,
      algorithms: new Map([[2, executorFor(2)], [3, executorFor(3)]])
    });
    const newerRunId = await v3Repository.startRebuild(accountId, { requestedBy: "v3-worker" });

    await expect(v2Repository.startRebuild(accountId, { requestedBy: "old-v2-cli" }))
      .rejects.toBeInstanceOf(ThreadingVersionSkewError);
    const candidate = await pool.query<{ status: string; building_run_id: string }>(
      `SELECT run.status, state.building_run_id
       FROM public.imap_thread_state state
       JOIN public.imap_thread_runs run ON run.id = state.building_run_id
       WHERE state.account_id = $1`,
      [accountId]
    );
    expect(candidate.rows[0]).toEqual({ status: "building", building_run_id: newerRunId });
  });

  it("prunes old terminal projections in bounded batches without deleting their audit operations", async () => {
    const accountId = await createAccount("run-retention");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Retention",
      rfcMessageId: "<run-retention@example.test>"
    });
    const first = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, first.runId as string);
    const second = await repository.rebuildAccount(accountId, { batchSize: 1, requestedBy: "live-test" });
    await activateReviewed(repository, accountId, second.runId as string);
    const third = await repository.rebuildAccount(accountId, { batchSize: 1, requestedBy: "live-test" });
    await activateReviewed(repository, accountId, third.runId as string);

    await pool.query(
      `UPDATE public.imap_thread_runs
       SET superseded_at = now() - interval '31 days',
           completed_at = coalesce(completed_at, now() - interval '31 days')
       WHERE id = $1`,
      [first.runId]
    );
    const operationsBefore = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.imap_thread_operations WHERE run_id = $1",
      [first.runId]
    );
    expect(Number(operationsBefore.rows[0]?.count)).toBeGreaterThan(0);

    expect(await repository.pruneTerminalRuns({ olderThanDays: 30, batchSize: 1 })).toEqual({
      runsDeleted: 1,
      assignmentsDeleted: 1
    });
    const retained = await pool.query<{ runs: string; operations: string; active: string; previous: string }>(
      `SELECT
         (SELECT count(*)::text FROM public.imap_thread_runs WHERE id = $2) AS runs,
         (SELECT count(*)::text FROM public.imap_thread_operations WHERE run_id = $2) AS operations,
         state.active_run_id::text AS active,
         state.previous_run_id::text AS previous
       FROM public.imap_thread_state state WHERE state.account_id = $1`,
      [accountId, first.runId]
    );
    expect(retained.rows[0]).toEqual({
      runs: "0",
      operations: operationsBefore.rows[0]?.count,
      active: third.runId,
      previous: second.runId
    });
  });

  it("acknowledges the evidence revision when the only subjectless message is deleted", async () => {
    const accountId = await createAccount("subjectless-delete-clock");
    const messageId = await seedMessage(accountId, {
      uid: 1,
      subject: null,
      rfcMessageId: "<subjectless-delete@example.test>"
    });
    const ready = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, ready.runId as string);

    await pool.query("DELETE FROM public.imap_messages WHERE id = $1", [messageId]);
    await drainRepositoryUntilIdle(repository, accountId, { batchSize: 1 });

    expect(await activeProjection(accountId)).toEqual([]);
    const revisions = await pool.query<{ evidence: string; caught: string; work: string }>(
      `SELECT clock.revision::text AS evidence,
              run.caught_up_revision::text AS caught,
              ((SELECT count(*) FROM public.imap_thread_work_queue WHERE run_id = run.id)
               + (SELECT count(*) FROM public.imap_thread_subject_work WHERE run_id = run.id))::text AS work
       FROM public.imap_thread_evidence_clock clock
       JOIN public.imap_thread_state state ON state.account_id = clock.account_id
       JOIN public.imap_thread_runs run ON run.id = state.active_run_id
       WHERE clock.account_id = $1`,
      [accountId]
    );
    expect(revisions.rows[0]).toEqual({
      evidence: revisions.rows[0]?.caught,
      caught: revisions.rows[0]?.caught,
      work: "0"
    });
  });

  it("makes activation wait for an in-flight legacy writer and then reject its newly queued evidence", async () => {
    const accountId = await createAccount("legacy-writer-barrier");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Barrier",
      rfcMessageId: "<barrier-root@example.test>"
    });
    const ready = await drainUntilReady(accountId, { batchSize: 1 });

    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "SELECT account_id FROM public.imap_thread_state WHERE account_id = $1 FOR SHARE",
        [accountId]
      );
      await writer.query(
        `INSERT INTO public.imap_messages (
           account_id, folder_path, uidvalidity, uid, internal_date,
           subject, rfc_message_id, message_id_normalized,
           window_status, size_bytes, headers_json
         ) VALUES (
           $1, 'INBOX', 101, 2, '2026-05-02T12:00:00Z',
           'Re: Barrier', '<barrier-reply@example.test>', 'barrier-reply@example.test',
           'IN_WINDOW', 0, '{}'::jsonb
         )`,
        [accountId]
      );

      let settled = false;
      const activation = repository.activateRun(accountId, ready.runId as string, {
        requestedBy: "live-test"
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      ).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);

      await writer.query("COMMIT");
      const outcome = await activation;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(String(outcome.error)).toMatch(/changed after review|catch up/);
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }

    const queued = await pool.query<{ count: string; revision: string }>(
      `SELECT
         (SELECT count(*)::text FROM public.imap_thread_work_queue WHERE run_id = $2) AS count,
         (SELECT revision::text FROM public.imap_thread_evidence_clock WHERE account_id = $1) AS revision`,
      [accountId, ready.runId]
    );
    expect(queued.rows[0]?.count).toBe("1");
    expect(Number(queued.rows[0]?.revision)).toBeGreaterThan(1);
  });

  it("invalidates a passed comparison certificate after either projection catches up to new mail", async () => {
    const accountId = await createAccount("comparison-drift");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Reviewed rollout",
      rfcMessageId: "<review-root@example.test>"
    });
    const baseline = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, baseline.runId as string);
    const candidate = await repository.rebuildAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test"
    });
    const reviewed = await repository.compareRuns(
      accountId,
      baseline.runId as string,
      candidate.runId as string,
      10,
      { requestedBy: "live-test" }
    );
    expect(reviewed.passed).toBe(true);

    await seedMessage(accountId, {
      uid: 2,
      subject: "Re: Reviewed rollout",
      rfcMessageId: "<review-reply@example.test>",
      inReplyTo: "<review-root@example.test>",
      referencesHeader: "<review-root@example.test>"
    });
    await drainRepositoryUntilIdle(repository, accountId, { batchSize: 1 });
    await expect(repository.activateRun(accountId, candidate.runId as string, {
      requestedBy: "live-test",
      comparisonId: reviewed.comparisonId
    })).rejects.toThrow(/does not match|changed after review/);

    const rereviewed = await repository.compareRuns(
      accountId,
      baseline.runId as string,
      candidate.runId as string,
      10,
      { requestedBy: "live-test" }
    );
    expect(rereviewed.passed).toBe(true);
    await repository.activateRun(accountId, candidate.runId as string, {
      requestedBy: "live-test",
      comparisonId: rereviewed.comparisonId
    });
    expect((await activeProjection(accountId)).every((row) => row.run_id === candidate.runId)).toBe(true);
  });
});
