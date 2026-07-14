import { describe, expect, it, vi } from "vitest";
import { MAX_SYNC_BATCH_SIZE, type AppConfig } from "../config.js";
import type { PgClient, PgPool } from "../db.js";
import { MirrorRepository } from "../repository.js";
import {
  MAX_SYNC_ATTACHMENTS_PER_BATCH,
  MAX_SYNC_FLAG_EVENT_LOGICAL_BYTES,
  MAX_SYNC_METADATA_BATCH_BYTES,
  MAX_SYNC_FLAGS_PER_BATCH,
  splitFlagEventBatches,
  splitFlagWriteBatches,
  splitMetadataWriteBatches
} from "../sync-limits.js";
import type { ImapFolder, ImapMessage, MessageMetadata } from "../types.js";

const folder = { id: "00000000-0000-4000-8000-000000000002", path: "INBOX" } as ImapFolder;

function metadata(uid: number): MessageMetadata {
  return {
    uid,
    internalDate: new Date("2026-06-01T00:00:00.000Z"),
    sizeBytes: 100,
    flags: ["\\Seen"],
    rfcMessageId: `<batch-${uid}@example.test>`,
    messageIdNormalized: `batch-${uid}@example.test`,
    providerMessageId: null,
    providerMessageIdNamespace: null,
    providerThreadId: null,
    providerThreadIdNamespace: null,
    inReplyTo: null,
    referencesHeader: null,
    subject: `batch-${uid}`,
    fromEmail: "sender@example.test",
    fromName: "Sender",
    toEmails: ["user@example.test"],
    toNames: ["User"],
    ccEmails: [],
    ccNames: [],
    bccEmails: [],
    headersJson: { "message-id": `<batch-${uid}@example.test>` },
    mimeStructure: null,
    attachments: []
  };
}

function repositoryStub(
  existingUids: number[] = [],
  afterQuery?: (sql: string) => void,
  folderUidValidity: string | null = "42001"
) {
  const calls: Array<{ sql: string; params: unknown[]; queryTimeout?: number }> = [];
  let connectCalls = 0;
  const client = {
    async query(
      query: string | { text: string; values?: unknown[]; query_timeout?: number },
      params: unknown[] = []
    ) {
      const normalized = (typeof query === "string" ? query : query.text).trim();
      const queryParams = typeof query === "string" ? params : query.values ?? [];
      calls.push({
        sql: normalized,
        params: queryParams,
        queryTimeout: typeof query === "string" ? undefined : query.query_timeout
      });
      afterQuery?.(normalized);
      if (normalized.includes("FROM public.imap_thread_state") && normalized.includes("FOR SHARE")) {
        return { rows: [{ account_id: "00000000-0000-4000-8000-000000000001" }] };
      }
      if (normalized.startsWith("SELECT id") && normalized.includes("FROM public.imap_folders")) {
        return { rows: [{ id: folder.id, uidvalidity: folderUidValidity }] };
      }
      if (normalized.startsWith("SELECT uid::text AS uid")) {
        return { rows: existingUids.map((uid) => ({ uid: String(uid) })) };
      }
      if (normalized.includes("INSERT INTO public.imap_messages")) {
        const input = JSON.parse(queryParams[0] as string) as Array<{ uid: number }>;
        return {
          rows: input.map((message) => ({
            id: `00000000-0000-4000-8000-${String(message.uid).padStart(12, "0")}`,
            uid: String(message.uid)
          })) as ImapMessage[]
        };
      }
      if (normalized.includes("INSERT INTO public.imap_attachments")) {
        const input = JSON.parse(queryParams[0] as string) as unknown[];
        return { rows: input.map((_, index) => ({ id: `attachment-${index}` })) };
      }
      if (normalized.includes("UPDATE public.imap_folders")) {
        return { rows: [{ id: folder.id }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const pool = {
    async connect() {
      connectCalls += 1;
      return client;
    }
  } as unknown as PgPool;
  return {
    calls,
    connectCalls: () => connectCalls,
    repository: new MirrorRepository(pool, {} as AppConfig)
  };
}

describe("repository metadata batching", () => {
  it("writes a 50-message batch with thirteen bounded database round trips", async () => {
    const stub = repositoryStub();
    const messages = Array.from({ length: 50 }, (_, index) => metadata(index + 1));

    const rows = await stub.repository.upsertMessages(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      messages,
      new Date("2026-01-01T00:00:00.000Z")
    );

    expect(rows.map((row) => Number(row.uid))).toEqual(messages.map((message) => message.uid));
    expect(stub.calls).toHaveLength(13);
    expect(stub.calls.filter((call) => call.sql === "BEGIN")).toHaveLength(1);
    expect(stub.calls.filter((call) => call.sql.startsWith("SELECT set_config"))).toHaveLength(5);
    expect(stub.calls.filter((call) => call.queryTimeout !== undefined)).toHaveLength(13);
    expect(stub.calls.filter((call) => call.sql.includes("INSERT INTO public.imap_messages"))).toHaveLength(1);
    expect(stub.calls.filter((call) => call.sql.includes("UPDATE public.imap_folders"))).toHaveLength(1);
    expect(stub.calls.filter((call) => call.sql === "COMMIT")).toHaveLength(1);
  });

  it("does not increment the header counter when the whole batch already exists", async () => {
    const stub = repositoryStub([1, 2]);
    await stub.repository.upsertMessages(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      [metadata(1), metadata(2)],
      new Date("2026-01-01T00:00:00.000Z")
    );

    expect(stub.calls.some((call) => call.sql.includes("UPDATE public.imap_folders"))).toBe(false);
    expect(stub.calls).toHaveLength(11);
  });

  it("rejects a stale UIDVALIDITY generation after taking the folder lock", async () => {
    const stub = repositoryStub();
    await expect(stub.repository.upsertMessages(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_000,
      [metadata(1)],
      new Date("2026-01-01T00:00:00.000Z")
    )).rejects.toThrow(/no longer matches folder/);

    expect(stub.calls.some((call) => call.sql.includes("INSERT INTO public.imap_messages"))).toBe(false);
    expect(stub.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("initializes a NULL folder generation in the first metadata transaction", async () => {
    const stub = repositoryStub([], undefined, null);
    await expect(stub.repository.upsertMessages(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      [metadata(1)],
      new Date("2026-01-01T00:00:00.000Z")
    )).resolves.toHaveLength(1);

    const initializeIndex = stub.calls.findIndex((call) =>
      call.sql.includes("SET uidvalidity = $2") && call.sql.includes("uidvalidity IS NULL")
    );
    const insertIndex = stub.calls.findIndex((call) =>
      call.sql.includes("INSERT INTO public.imap_messages")
    );
    expect(initializeIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(initializeIndex);
    expect(stub.calls[initializeIndex].params).toEqual([folder.id, 42_001]);
    expect(stub.calls.filter((call) => call.sql === "BEGIN")).toHaveLength(1);
    expect(stub.calls.filter((call) => call.sql === "COMMIT")).toHaveLength(1);
  });

  it("rejects duplicate UIDs before opening a database connection", async () => {
    const stub = repositoryStub();
    await expect(
      stub.repository.upsertMessages(
        "00000000-0000-4000-8000-000000000001",
        folder,
        42_001,
        [metadata(1), metadata(1)],
        new Date("2026-01-01T00:00:00.000Z")
      )
    ).rejects.toThrow(/duplicate UIDs/);
    expect(stub.connectCalls()).toBe(0);
  });

  it("rejects unsafe message and attachment sizes before opening a database connection", async () => {
    const stub = repositoryStub();
    await expect(
      stub.repository.upsertMessages(
        "00000000-0000-4000-8000-000000000001",
        folder,
        42_001,
        [{ ...metadata(1), sizeBytes: Number.NaN }],
        new Date("2026-01-01T00:00:00.000Z")
      )
    ).rejects.toThrow(/invalid size/);

    await expect(
      stub.repository.upsertMessages(
        "00000000-0000-4000-8000-000000000001",
        folder,
        42_001,
        [{
          ...metadata(2),
          attachments: [{
            filename: "unsafe.bin",
            mimeType: "application/octet-stream",
            sizeBytes: Number.POSITIVE_INFINITY,
            disposition: "attachment",
            contentId: null,
            partNumber: "1"
          }]
        }],
        new Date("2026-01-01T00:00:00.000Z")
      )
    ).rejects.toThrow(/invalid attachment size/);
    expect(stub.connectCalls()).toBe(0);
  });

  it("rejects an oversized direct repository batch before copying or connecting", async () => {
    const stub = repositoryStub();
    const repeated = metadata(1);
    const messages = Array.from({ length: MAX_SYNC_BATCH_SIZE + 1 }, (_, index) => ({
      ...repeated,
      uid: index + 1
    }));

    await expect(stub.repository.upsertMessages(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      messages,
      new Date("2026-01-01T00:00:00.000Z")
    )).rejects.toThrow(/exceeds maximum/);
    expect(stub.connectCalls()).toBe(0);
  });

  it("splits otherwise-valid metadata on serialized bytes and attachment count", () => {
    const byteHeavy = [
      { ...metadata(1), subject: "a".repeat(MAX_SYNC_METADATA_BATCH_BYTES / 2) },
      { ...metadata(2), subject: "b".repeat(MAX_SYNC_METADATA_BATCH_BYTES / 2) }
    ];
    expect(splitMetadataWriteBatches(byteHeavy).map((batch) => batch.length)).toEqual([1, 1]);

    const attachment = {
      filename: "small.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 1,
      disposition: "attachment" as const,
      contentId: null,
      partNumber: "1"
    };
    const attachmentHeavy = [
      { ...metadata(3), attachments: Array.from({ length: 3_000 }, () => attachment) },
      { ...metadata(4), attachments: Array.from({ length: 3_000 }, () => attachment) }
    ];
    expect(splitMetadataWriteBatches(attachmentHeavy).map((batch) => batch.length)).toEqual([1, 1]);
  });

  it("keeps byte-bounded statements inside one logical transaction", async () => {
    const stub = repositoryStub();
    const attachment = {
      filename: "small.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 1,
      disposition: "attachment" as const,
      contentId: null,
      partNumber: "1"
    };
    const messages = [
      {
        ...metadata(1),
        attachments: Array.from(
          { length: 3_000 },
          (_, index) => ({ ...attachment, partNumber: String(index + 1) })
        )
      },
      {
        ...metadata(2),
        attachments: Array.from(
          { length: 3_000 },
          (_, index) => ({ ...attachment, partNumber: String(index + 1) })
        )
      }
    ];

    await expect(stub.repository.upsertMessages(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      messages,
      new Date("2026-01-01T00:00:00.000Z")
    )).resolves.toHaveLength(2);
    expect(stub.calls.filter((call) => call.sql === "BEGIN")).toHaveLength(1);
    expect(stub.calls.filter((call) => call.sql === "COMMIT")).toHaveLength(1);
    expect(stub.calls.filter((call) => call.sql.includes("INSERT INTO public.imap_messages"))).toHaveLength(2);
    expect(stub.calls.filter((call) => call.sql.includes("INSERT INTO public.imap_attachments"))).toHaveLength(2);
    expect(stub.calls.filter((call) => call.sql.includes("UPDATE public.imap_folders"))).toHaveLength(1);
  });

  it("rejects a single pathological metadata record before connecting", async () => {
    const stub = repositoryStub();
    await expect(stub.repository.upsertMessages(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      [{ ...metadata(1), subject: "x".repeat(MAX_SYNC_METADATA_BATCH_BYTES) }],
      new Date("2026-01-01T00:00:00.000Z")
    )).rejects.toThrow(/byte write limit/);

    const attachment = {
      filename: "small.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 1,
      disposition: "attachment" as const,
      contentId: null,
      partNumber: "1"
    };
    await expect(stub.repository.upsertMessages(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      [{
        ...metadata(2),
        attachments: Array.from(
          { length: MAX_SYNC_ATTACHMENTS_PER_BATCH + 1 },
          (_, index) => ({ ...attachment, partNumber: String(index + 1) })
        )
      }],
      new Date("2026-01-01T00:00:00.000Z")
    )).rejects.toThrow(/attachment write limit/);
    expect(stub.connectCalls()).toBe(0);
  });

  it("rejects an aggregate logical metadata transaction before connecting", async () => {
    const stub = repositoryStub();
    const subject = "x".repeat(Math.floor((MAX_SYNC_METADATA_BATCH_BYTES * 4) / 5));
    const messages = Array.from({ length: 6 }, (_, index) => ({
      ...metadata(index + 1),
      subject
    }));

    await expect(stub.repository.upsertMessages(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      messages,
      new Date("2026-01-01T00:00:00.000Z")
    )).rejects.toThrow(/aggregate logical write limit/);
    expect(stub.connectCalls()).toBe(0);
  });

  it("bounds pool acquisition and releases a connection that arrives after the metadata deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    try {
      let resolveConnection!: (client: PgClient) => void;
      const waitingConnection = new Promise<PgClient>((resolve) => {
        resolveConnection = resolve;
      });
      const query = vi.fn();
      const release = vi.fn();
      const pool = { connect: () => waitingConnection } as unknown as PgPool;
      const repository = new MirrorRepository(pool, {} as AppConfig);
      const write = repository.upsertMessages(
        "00000000-0000-4000-8000-000000000001",
        folder,
        42_001,
        [metadata(1)],
        new Date("2026-01-01T00:00:00.000Z"),
        { deadlineAt: Date.now() + 10 }
      );
      const rejection = expect(write).rejects.toThrow(/metadata write deadline exceeded/);

      await vi.advanceTimersByTimeAsync(11);
      await rejection;
      resolveConnection({ query, release } as unknown as PgClient);
      await Promise.resolve();

      expect(query).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts queued pool acquisition and returns the untouched late client normally", async () => {
    let resolveConnection!: (client: PgClient) => void;
    const waitingConnection = new Promise<PgClient>((resolve) => {
      resolveConnection = resolve;
    });
    const query = vi.fn();
    const release = vi.fn();
    const pool = { connect: () => waitingConnection } as unknown as PgPool;
    const repository = new MirrorRepository(pool, {} as AppConfig);
    const abort = new AbortController();
    const write = repository.upsertMessages(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      [metadata(1)],
      new Date("2026-01-01T00:00:00.000Z"),
      { deadlineAt: Date.now() + 10_000, signal: abort.signal }
    );

    abort.abort();
    await expect(write).rejects.toThrow(/sync database write interrupted/);
    resolveConnection({ query, release } as unknown as PgClient);
    await Promise.resolve();

    expect(query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith();
  });

  it("accepts an acknowledged COMMIT even when the wall clock crosses the deadline", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const stub = repositoryStub([], (sql) => {
      if (sql === "COMMIT") now = 2_001;
    });
    try {
      await expect(stub.repository.upsertMessages(
        "00000000-0000-4000-8000-000000000001",
        folder,
        42_001,
        [metadata(1)],
        new Date("2026-01-01T00:00:00.000Z"),
        { deadlineAt: 2_000 }
      )).resolves.toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
    expect(stub.calls.at(-1)?.sql).toBe("COMMIT");
  });
});

describe("repository flag scan deadline", () => {
  it("rejects aggregate stored flags before materializing any arrays", async () => {
    const calls: string[] = [];
    const client = {
      async query(query: string | { text: string }) {
        const sql = (typeof query === "string" ? query : query.text).trim();
        calls.push(sql);
        if (sql.includes("WITH locked AS MATERIALIZED")) {
          return {
            rows: [{
              stored_bytes: String(MAX_SYNC_FLAG_EVENT_LOGICAL_BYTES + 1),
              stored_flags: "1"
            }]
          };
        }
        return { rows: [] };
      },
      release() {}
    };
    const pool = { async connect() { return client; } } as unknown as PgPool;
    const repository = new MirrorRepository(
      pool,
      { FLAG_SCAN_TOTAL_TIMEOUT_MS: 10_000 } as AppConfig
    );

    await expect(repository.applyFlagScan(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      [{ uid: 1, flags: [] }]
    )).rejects.toThrow(/stored flags exceed the aggregate logical event limit/i);

    expect(calls.some((sql) => sql.startsWith("SELECT *"))).toBe(false);
    expect(calls.find((sql) => sql.includes("WITH locked AS MATERIALIZED"))).toContain(
      "octet_length(to_json(flags)::text)"
    );
    expect(calls.at(-1)).toBe("ROLLBACK");
  });

  it("splits aggregate flag payloads and rejects a pathological single UID", async () => {
    const flags = Array.from({ length: 3_000 }, (_, index) => `keyword-${index}`);
    expect(splitFlagWriteBatches([
      { uid: 1, flags },
      { uid: 2, flags }
    ]).map((batch) => batch.length)).toEqual([1, 1]);

    const connect = vi.fn();
    const repository = new MirrorRepository(
      { connect } as unknown as PgPool,
      { FLAG_SCAN_TOTAL_TIMEOUT_MS: 10_000 } as AppConfig
    );
    await expect(repository.applyFlagScan(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      [{
        uid: 1,
        flags: Array.from({ length: MAX_SYNC_FLAGS_PER_BATCH + 1 }, (_, index) => `keyword-${index}`)
      }]
    )).rejects.toThrow(/flag write limit/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("budgets flag events using both stored and incoming representations", () => {
    const previousFlags = Array.from({ length: MAX_SYNC_FLAGS_PER_BATCH }, (_, index) => `old-${index}`);
    const event = (uid: number) => ({
      message: { uid },
      previousFlags,
      nextFlags: []
    });
    expect(splitFlagEventBatches([event(1), event(2), event(3)]).map((batch) => batch.length))
      .toEqual([2, 1]);
    expect(splitFlagEventBatches([{
      message: { uid: 4 },
      previousFlags,
      nextFlags: ["new-keyword"]
    }])).toHaveLength(1);
    expect(() => splitFlagEventBatches([{
      message: { uid: 5 },
      previousFlags: Array.from({ length: 6_000 }, (_, index) => `old-${index}`),
      nextFlags: Array.from({ length: MAX_SYNC_FLAGS_PER_BATCH }, (_, index) => `new-${index}`)
    }])).toThrow(/event write limit/);
    expect(() => splitFlagEventBatches(Array.from({ length: 9 }, (_, index) => ({
      message: { uid: index + 10 },
      previousFlags: Array.from({ length: MAX_SYNC_FLAGS_PER_BATCH }, (_, flag) => `old-${flag}`),
      nextFlags: []
    })))).toThrow(/aggregate logical write limit/);
  });

  it("rejects pathological stored flags before sorting or writing", async () => {
    const storedFlags = Array.from(
      { length: MAX_SYNC_FLAGS_PER_BATCH + 1 },
      (_, index) => `legacy-${index}`
    );
    const pool = {
      query: vi.fn(async () => ({
        rows: [{
          id: "00000000-0000-4000-8000-000000000010",
          uid: "1",
          flags: storedFlags
        }]
      }))
    } as unknown as PgPool;
    const repository = new MirrorRepository(pool, {} as AppConfig);
    const upsert = vi.spyOn(repository, "upsertMessages");
    const logEvent = vi.spyOn(repository, "logEvent");

    await expect(repository.applyFlagScan(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      [metadata(1)],
      new Date("2026-01-01T00:00:00.000Z")
    )).rejects.toThrow(/stored flags.*event limit/i);
    expect(upsert).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("rejects duplicate and oversized projected batches before opening a connection", async () => {
    const connect = vi.fn();
    const repository = new MirrorRepository(
      { connect } as unknown as PgPool,
      { FLAG_SCAN_TOTAL_TIMEOUT_MS: 10_000 } as AppConfig
    );

    await expect(repository.applyFlagScan(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      [{ uid: 1, flags: [] }, { uid: 1, flags: ["\\Seen"] }]
    )).rejects.toThrow(/duplicate UIDs/);
    await expect(repository.applyFlagScan(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      Array.from({ length: MAX_SYNC_BATCH_SIZE + 1 }, (_, index) => ({
        uid: index + 1,
        flags: []
      }))
    )).rejects.toThrow(/exceeds maximum/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("preserves the legacy full-metadata Date contract", async () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000010",
      uid: "1",
      flags: []
    } as unknown as ImapMessage;
    const pool = {
      query: vi.fn(async () => ({ rows: [row] }))
    } as unknown as PgPool;
    const repository = new MirrorRepository(pool, {} as AppConfig);
    const upsert = vi.spyOn(repository, "upsertMessages").mockResolvedValue([{ ...row, flags: ["\\Seen"] }]);
    const logEvent = vi.spyOn(repository, "logEvent").mockResolvedValue();
    const windowCutoff = new Date("2026-01-01T00:00:00.000Z");

    const result = await repository.applyFlagScan(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      [metadata(1)],
      windowCutoff
    );

    expect(result).toMatchObject({ flagsChanged: 1 });
    expect(upsert).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      [metadata(1)],
      windowCutoff
    );
    expect(logEvent).toHaveBeenCalledOnce();
  });

  it("rejects aggregate legacy stored flags without returning arrays to Node", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{
          id: null,
          uid: null,
          flags: null,
          stored_bytes: String(MAX_SYNC_FLAG_EVENT_LOGICAL_BYTES + 1),
          stored_flags: "1"
        }]
      }))
    } as unknown as PgPool;
    const repository = new MirrorRepository(pool, {} as AppConfig);
    const upsert = vi.spyOn(repository, "upsertMessages");
    const logEvent = vi.spyOn(repository, "logEvent");

    await expect(repository.applyFlagScan(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      [metadata(1)],
      new Date("2026-01-01T00:00:00.000Z")
    )).rejects.toThrow(/stored flags exceed the aggregate logical event limit/i);

    expect(upsert).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      "LEFT JOIN candidates"
    );
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      "octet_length(to_json(flags)::text)"
    );
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toContain(
      "pg_column_size(flags)"
    );
  });

  it("bounds pool acquisition and releases a connection that arrives after the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    try {
      let resolveConnection!: (client: PgClient) => void;
      const waitingConnection = new Promise<PgClient>((resolve) => {
        resolveConnection = resolve;
      });
      const query = vi.fn();
      const release = vi.fn();
      const pool = { connect: () => waitingConnection } as unknown as PgPool;
      const repository = new MirrorRepository(pool, { FLAG_SCAN_TOTAL_TIMEOUT_MS: 10 } as AppConfig);
      const scan = repository.applyFlagScan(
        "00000000-0000-4000-8000-000000000001",
        folder,
        42_001,
        [{ uid: 1, flags: ["\\Seen"] }]
      );
      const rejection = expect(scan).rejects.toThrow(/FLAG_SCAN_TOTAL_TIMEOUT_MS exceeded/);

      await vi.advanceTimersByTimeAsync(11);
      await rejection;
      resolveConnection({ query, release } as unknown as PgClient);
      await Promise.resolve();

      expect(query).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the remaining database timeout before every blocking statement", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const row = {
      id: "00000000-0000-4000-8000-000000000010",
      uid: "1",
      flags: []
    } as unknown as ImapMessage;
    const client = {
      async query(
        query: string | { text: string; values?: unknown[] },
        params: unknown[] = []
      ) {
        const normalized = (typeof query === "string" ? query : query.text).trim();
        const queryParams = typeof query === "string" ? params : query.values ?? [];
        calls.push({ sql: normalized, params: queryParams });
        now += 10;
        if (normalized.startsWith("SELECT *")) return { rows: [row] };
        if (normalized.includes("UPDATE public.imap_messages")) {
          return { rows: [{ ...row, flags: ["\\Seen"] }] };
        }
        if (normalized.includes("INSERT INTO public.imap_sync_events")) {
          return { rows: [{ id: "00000000-0000-4000-8000-000000000011" }] };
        }
        return { rows: [] };
      },
      release() {}
    };
    const pool = { async connect() { return client; } } as unknown as PgPool;
    const repository = new MirrorRepository(pool, { FLAG_SCAN_TOTAL_TIMEOUT_MS: 1_000 } as AppConfig);

    try {
      await expect(repository.applyFlagScan(
        "00000000-0000-4000-8000-000000000001",
        folder,
        42_001,
        [{ uid: 1, flags: ["\\Seen"] }],
        { deadlineAt: 2_000 }
      )).resolves.toMatchObject({ flagsChanged: 1 });
    } finally {
      nowSpy.mockRestore();
    }

    const kind = (sql: string): string => {
      if (sql === "BEGIN" || sql === "COMMIT") return sql;
      if (sql.startsWith("SELECT set_config")) return "TIMEOUT";
      if (sql.startsWith("SELECT *")) return "SELECT";
      if (sql.includes("UPDATE public.imap_messages")) return "UPDATE";
      if (sql.includes("INSERT INTO public.imap_sync_events")) return "EVENT";
      return "OTHER";
    };
    expect(calls.map((call) => kind(call.sql))).toEqual([
      "BEGIN",
      "TIMEOUT",
      "OTHER",
      "TIMEOUT",
      "SELECT",
      "TIMEOUT",
      "UPDATE",
      "TIMEOUT",
      "EVENT",
      "TIMEOUT",
      "COMMIT"
    ]);
    const timeoutValues = calls
      .filter((call) => kind(call.sql) === "TIMEOUT")
      .map((call) => call.params[0]);
    expect(timeoutValues).toEqual(["990ms", "970ms", "950ms", "930ms", "910ms"]);
    for (const call of calls.filter((candidate) => kind(candidate.sql) === "TIMEOUT")) {
      expect(call.sql).toContain("set_config('lock_timeout'");
      expect(call.sql).toContain("set_config('statement_timeout'");
    }
  });

  it("writes fifty changed flag rows with one update and one event insert", async () => {
    const calls: string[] = [];
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      uid: String(index + 1),
      flags: []
    })) as unknown as ImapMessage[];
    const client = {
      async query(query: string | { text: string; values?: unknown[] }) {
        const normalized = (typeof query === "string" ? query : query.text).trim();
        calls.push(normalized);
        if (normalized.startsWith("SELECT *")) return { rows };
        if (normalized.includes("UPDATE public.imap_messages")) {
          return { rows: rows.map((row) => ({ ...row, flags: ["\\Seen"] })) };
        }
        if (normalized.includes("INSERT INTO public.imap_sync_events")) {
          return { rows: rows.map((row) => ({ id: row.id })) };
        }
        return { rows: [] };
      },
      release() {}
    };
    const pool = { async connect() { return client; } } as unknown as PgPool;
    const repository = new MirrorRepository(pool, { FLAG_SCAN_TOTAL_TIMEOUT_MS: 10_000 } as AppConfig);

    const result = await repository.applyFlagScan(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      rows.map((row) => ({ uid: Number(row.uid), flags: ["\\Seen"] }))
    );

    expect(result.flagsChanged).toBe(50);
    expect(result.messages).toHaveLength(50);
    expect(calls).toHaveLength(11);
    expect(calls.filter((sql) => sql.includes("UPDATE public.imap_messages"))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes("INSERT INTO public.imap_sync_events"))).toHaveLength(1);
  });

  it("keeps split flag statements inside one logical transaction", async () => {
    const calls: string[] = [];
    const rows = [1, 2, 3].map((uid) => ({
      id: `00000000-0000-4000-8000-${String(uid).padStart(12, "0")}`,
      uid: String(uid),
      flags: []
    })) as unknown as ImapMessage[];
    const client = {
      async query(query: string | { text: string; values?: unknown[] }) {
        const normalized = (typeof query === "string" ? query : query.text).trim();
        const values = typeof query === "string" ? [] : query.values ?? [];
        calls.push(normalized);
        if (normalized.startsWith("SELECT *")) return { rows };
        if (normalized.includes("UPDATE public.imap_messages")) {
          const input = JSON.parse(values[0] as string) as Array<{ id: string; flags: string[] }>;
          return {
            rows: input.map((change) => ({
              ...rows.find((row) => row.id === change.id),
              flags: change.flags
            }))
          };
        }
        if (normalized.includes("INSERT INTO public.imap_sync_events")) {
          const input = JSON.parse(values[0] as string) as unknown[];
          return { rows: input.map((_, index) => ({ id: `event-${index}` })) };
        }
        return { rows: [] };
      },
      release() {}
    };
    const pool = { async connect() { return client; } } as unknown as PgPool;
    const repository = new MirrorRepository(pool, { FLAG_SCAN_TOTAL_TIMEOUT_MS: 10_000 } as AppConfig);
    const flags = Array.from({ length: MAX_SYNC_FLAGS_PER_BATCH }, (_, index) => `keyword-${index}`);

    const result = await repository.applyFlagScan(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      [{ uid: 1, flags }, { uid: 2, flags }, { uid: 3, flags }]
    );

    expect(result).toMatchObject({ flagsChanged: 3 });
    expect(calls.filter((sql) => sql === "BEGIN")).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes("UPDATE public.imap_messages"))).toHaveLength(3);
    expect(calls.filter((sql) => sql.includes("INSERT INTO public.imap_sync_events"))).toHaveLength(2);
    expect(calls.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(calls).not.toContain("ROLLBACK");
  });

  it("rolls back every flag statement when a later split write fails", async () => {
    const calls: string[] = [];
    const rows = [1, 2].map((uid) => ({
      id: `00000000-0000-4000-8000-${String(uid).padStart(12, "0")}`,
      uid: String(uid),
      flags: []
    })) as unknown as ImapMessage[];
    let updateCount = 0;
    const client = {
      async query(query: string | { text: string; values?: unknown[] }) {
        const normalized = (typeof query === "string" ? query : query.text).trim();
        const values = typeof query === "string" ? [] : query.values ?? [];
        calls.push(normalized);
        if (normalized.startsWith("SELECT *")) return { rows };
        if (normalized.includes("UPDATE public.imap_messages")) {
          updateCount += 1;
          if (updateCount === 2) throw new Error("second flag chunk failed");
          const input = JSON.parse(values[0] as string) as Array<{ id: string; flags: string[] }>;
          return { rows: [{ ...rows[0], flags: input[0].flags }] };
        }
        return { rows: [] };
      },
      release() {}
    };
    const pool = { async connect() { return client; } } as unknown as PgPool;
    const repository = new MirrorRepository(pool, { FLAG_SCAN_TOTAL_TIMEOUT_MS: 10_000 } as AppConfig);
    const flags = Array.from({ length: 3_000 }, (_, index) => `keyword-${index}`);

    await expect(repository.applyFlagScan(
      "00000000-0000-4000-8000-000000000001",
      folder,
      42_001,
      [{ uid: 1, flags }, { uid: 2, flags }]
    )).rejects.toThrow("second flag chunk failed");

    expect(calls.filter((sql) => sql === "BEGIN")).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes("UPDATE public.imap_messages"))).toHaveLength(2);
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
  });

  it("rolls back before a blocking statement when timeout setup exhausts the budget", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const calls: string[] = [];
    const release = vi.fn();
    const client = {
      async query(query: string | { text: string }) {
        const normalized = (typeof query === "string" ? query : query.text).trim();
        calls.push(normalized);
        if (normalized.startsWith("SELECT set_config")) now = 2_001;
        return { rows: [] };
      },
      release
    };
    const pool = { async connect() { return client; } } as unknown as PgPool;
    const repository = new MirrorRepository(pool, { FLAG_SCAN_TOTAL_TIMEOUT_MS: 1_000 } as AppConfig);

    try {
      await expect(repository.applyFlagScan(
        "00000000-0000-4000-8000-000000000001",
        folder,
        42_001,
        [{ uid: 1, flags: ["\\Seen"] }],
        { deadlineAt: 2_000 }
      )).rejects.toThrow(/FLAG_SCAN_TOTAL_TIMEOUT_MS exceeded/);
    } finally {
      nowSpy.mockRestore();
    }

    expect(calls).toEqual([
      "BEGIN",
      "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $1, true)",
      "ROLLBACK"
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
});
