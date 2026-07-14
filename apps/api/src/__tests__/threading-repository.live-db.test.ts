import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getConfig } from "../config.js";
import { closePool, getPool } from "../db.js";
import { MirrorRepository } from "../repository.js";
import {
  ThreadingClosureLimitError,
  ThreadingEvidenceLimitError,
  ThreadingRepository,
  ThreadingVersionSkewError,
  type ThreadingRunResult
} from "../threading-repository.js";
import {
  computeThreadAssignments,
  type ThreadingAssignment,
  type ThreadingMessageInput,
  type ThreadingOptions
} from "../threading.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

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

  async function drainUntilReady(
    accountId: string,
    options: { batchSize?: number; maxSubjectBucketMessages?: number } = {}
  ): Promise<ThreadingRunResult> {
    let last: ThreadingRunResult | null = null;
    for (let pass = 0; pass < 200; pass += 1) {
      last = await repository.drainAccount(accountId, { ...options, requestedBy: "live-test" });
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
    return (messages: readonly ThreadingMessageInput[], options?: ThreadingOptions): ThreadingAssignment[] =>
      computeThreadAssignments(messages, options).map((assignment) => ({
        ...assignment,
        algorithm_version: version,
        input_hash: createHash("sha256")
          .update(`${assignment.input_hash}\u0000algorithm-version:${version}`)
          .digest("hex")
      }));
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
    const audit = await pool.query<{
      original_status: string;
      rollback_changes: string;
      deleted_assignments: string;
    }>(
      `SELECT original.status AS original_status,
              (SELECT count(*)::text FROM public.imap_thread_assignment_history h
               WHERE h.operation_id = $2) AS rollback_changes,
              (SELECT count(*)::text FROM public.imap_thread_assignment_history h
               WHERE h.operation_id = $2 AND h.change_type = 'delete') AS deleted_assignments
       FROM public.imap_thread_operations original
       WHERE original.id = $1`,
      [material?.operationId, rollback.operationId]
    );
    expect(audit.rows[0]).toEqual({
      original_status: "rolled_back",
      rollback_changes: "2",
      deleted_assignments: "1"
    });
  });

  it("preserves audit history and recomputes survivors when retention purges a thread member", async () => {
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

  it("fails closed with persisted backoff before a protocol closure can exceed its bound", async () => {
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

    const delayed = await pool.query<{ attempts: number; delayed: boolean; failures: string }>(
      `SELECT run.attempts,
              run.available_at > now() AS delayed,
              (SELECT count(*)::text FROM public.imap_thread_operations operation
               WHERE operation.run_id = run.id
                 AND operation.operation_type = 'failure'
                 AND operation.status = 'failed') AS failures
       FROM public.imap_thread_runs run WHERE run.id = $1`,
      [ready.runId]
    );
    expect(delayed.rows[0]).toEqual({ attempts: 1, delayed: true, failures: "1" });
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

    const failed = await pool.query<{ attempts: number; error: string | null }>(
      `SELECT attempts, last_error AS error
       FROM public.imap_thread_runs WHERE account_id = $1 AND status = 'building'`,
      [accountId]
    );
    expect(failed.rows[0]?.attempts).toBe(1);
    expect(failed.rows[0]?.error).toMatch(/evidence bytes/);
  });

  it("lets an older rolling-deploy worker observe but never mutate a newer active run", async () => {
    const accountId = await createAccount("version-skew");
    const newer = await pool.query<{ id: string }>(
      `INSERT INTO public.imap_thread_runs (
         account_id, algorithm_version, mode, status, stage,
         completed_at, activated_at, requested_by, reason
       ) VALUES ($1, 2, 'initial', 'active', 'ready', now(), now(), 'live-test', 'future worker')
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
      .rejects.toThrow(/active.*v2.*no retained executor/i);
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
    await seedMessage(accountId, {
      uid: 1,
      subject: "Rollout",
      rfcMessageId: "<rollout-root@example.test>"
    });
    const baseline = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, baseline.runId as string);
    const candidate = await repository.rebuildAccount(accountId, {
      batchSize: 1,
      requestedBy: "live-test",
      reason: "same-version rollout"
    });
    const activation = await activateReviewed(repository, accountId, candidate.runId as string);

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

    await repository.rollbackOperation(accountId, activation.operationId as string, "live-test");
    const active = await activeProjection(accountId);
    expect(active).toHaveLength(2);
    expect(active.every((row) => row.run_id === baseline.runId)).toBe(true);
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
    const v1 = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, v1.runId as string);

    const v2Repository = new ThreadingRepository(pool, {
      currentAlgorithmVersion: 2,
      algorithms: new Map([
        [1, executorFor(1)],
        [2, executorFor(2)]
      ])
    });
    const v2RunId = await v2Repository.startRebuild(accountId, {
      batchSize: 1,
      requestedBy: "v2-worker",
      reason: "v2 shadow"
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
      await v2Repository.drainAccount(accountId, { batchSize: 1, requestedBy: "v2-worker" });
      const status = await v2Repository.getRun(v2RunId);
      if (status.status === "ready") break;
    }
    expect((await v2Repository.getRun(v2RunId)).status).toBe("ready");
    expect(await projection(v1.runId as string)).toHaveLength(2);

    const activation = await activateReviewed(v2Repository, accountId, v2RunId, "v2-worker");
    const afterActivation = await seedMessage(accountId, {
      uid: 3,
      subject: "Re: Versioned rollout",
      rfcMessageId: "<version-live-reply@example.test>",
      inReplyTo: "<version-build-reply@example.test>",
      referencesHeader: "<version-root@example.test> <version-build-reply@example.test>"
    });
    await enqueueMessage(accountId, afterActivation);
    await drainRepositoryUntilIdle(v2Repository, accountId, { batchSize: 1 });
    expect(await projection(v1.runId as string)).toHaveLength(3);
    expect(await projection(v2RunId)).toHaveLength(3);

    await v2Repository.rollbackOperation(accountId, activation.operationId as string, "live-test");
    const active = await activeProjection(accountId);
    expect(active).toHaveLength(3);
    expect(active.every((row) => row.run_id === v1.runId)).toBe(true);
  });

  it("fails rollout compatibility when a state-referenced run has no retained executor", async () => {
    const accountId = await createAccount("missing-retained-executor");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Retained executor",
      rfcMessageId: "<retained-executor@example.test>"
    });
    const v1 = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, v1.runId as string);

    const unsafeV2Repository = new ThreadingRepository(pool, {
      currentAlgorithmVersion: 2,
      algorithms: new Map([[2, executorFor(2)]])
    });
    await expect(unsafeV2Repository.assertRolloutCompatibility())
      .rejects.toThrow(/active.*v1.*no retained executor/i);
    await expect(unsafeV2Repository.startRebuild(accountId, { requestedBy: "unsafe-v2-cli" }))
      .rejects.toThrow(/active.*v1.*no retained executor/i);
    await expect(unsafeV2Repository.drainAccount(accountId, { requestedBy: "unsafe-v2-cli" }))
      .rejects.toThrow(/active.*v1.*no retained executor/i);

    const safeV2Repository = new ThreadingRepository(pool, {
      currentAlgorithmVersion: 2,
      algorithms: new Map([[1, executorFor(1)], [2, executorFor(2)]])
    });
    await expect(safeV2Repository.assertRolloutCompatibility()).resolves.toBeUndefined();
  });

  it("refuses to let an older binary supersede a newer shadow candidate", async () => {
    const accountId = await createAccount("old-rebuild-guard");
    await seedMessage(accountId, {
      uid: 1,
      subject: "Upgrade guard",
      rfcMessageId: "<upgrade-guard@example.test>"
    });
    const baseline = await drainUntilReady(accountId, { batchSize: 1 });
    await activateReviewed(repository, accountId, baseline.runId as string);
    const v2Repository = new ThreadingRepository(pool, {
      currentAlgorithmVersion: 2,
      algorithms: new Map([[1, executorFor(1)], [2, executorFor(2)]])
    });
    const newerRunId = await v2Repository.startRebuild(accountId, { requestedBy: "v2-worker" });

    await expect(repository.startRebuild(accountId, { requestedBy: "old-v1-cli" }))
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
