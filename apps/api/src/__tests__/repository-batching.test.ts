import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { PgClient, PgPool } from "../db.js";
import { MirrorRepository } from "../repository.js";
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
    providerThreadId: null,
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

function repositoryStub(existingUids: number[] = [], afterQuery?: (sql: string) => void) {
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
      if (normalized.startsWith("WITH locked_folder AS MATERIALIZED")) {
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
  it("writes a 50-message batch with nine bounded database round trips", async () => {
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
    expect(stub.calls).toHaveLength(9);
    expect(stub.calls.filter((call) => call.sql === "BEGIN")).toHaveLength(1);
    expect(stub.calls.filter((call) => call.sql.startsWith("SELECT set_config"))).toHaveLength(4);
    expect(stub.calls.filter((call) => call.queryTimeout !== undefined)).toHaveLength(9);
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
    expect(stub.calls).toHaveLength(7);
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
        if (normalized.startsWith("UPDATE public.imap_messages")) {
          return { rows: [{ ...row, flags: ["\\Seen"] }] };
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
      if (sql.startsWith("UPDATE public.imap_messages")) return "UPDATE";
      if (sql.startsWith("INSERT INTO public.imap_sync_events")) return "EVENT";
      return "OTHER";
    };
    expect(calls.map((call) => kind(call.sql))).toEqual([
      "BEGIN",
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
    expect(timeoutValues).toEqual(["990ms", "970ms", "950ms", "930ms"]);
    for (const call of calls.filter((candidate) => kind(candidate.sql) === "TIMEOUT")) {
      expect(call.sql).toContain("set_config('lock_timeout'");
      expect(call.sql).toContain("set_config('statement_timeout'");
    }
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
