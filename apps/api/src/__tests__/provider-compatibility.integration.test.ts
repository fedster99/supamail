import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "../db.js";
import type { FetchMessage, MailboxLock } from "../imap-client.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "../smoke/fixture-imap.js";
import { resetConfigForTests } from "../config.js";
import { forceFolderDiscovery, setupIntegration, teardownIntegration } from "./helpers/integration-harness.js";

const DB_AVAILABLE = Boolean(process.env.DATABASE_URL);
const integration = DB_AVAILABLE ? describe : describe.skip;

class DisconnectingFixtureImapClient extends FixtureImapClient {
  constructor(folders: FixtureFolder[], private readonly failingFolderPath: string) {
    super(folders);
  }

  async getMailboxLock(path: string): Promise<MailboxLock> {
    if (path === this.failingFolderPath) {
      throw new Error("provider transient disconnect during SELECT");
    }
    return super.getMailboxLock(path);
  }
}

class NoSourceFixtureImapClient extends FixtureImapClient {
  async fetchOne(
    range: string,
    query: Record<string, unknown> = {},
    options?: Record<string, unknown>
  ): Promise<FetchMessage | false | null> {
    const fetched = await super.fetchOne(range, query, options);
    if (!fetched) return fetched;
    return { ...fetched, source: undefined };
  }
}

integration("provider compatibility fixtures (real Postgres + fixture IMAP)", () => {
  const activeAccountIds: string[] = [];

  beforeAll(() => {
    resetConfigForTests();
  });

  afterEach(async () => {
    const pool = getPool();
    while (activeAccountIds.length > 0) {
      const id = activeAccountIds.pop()!;
      await teardownIntegration(pool, id).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it("mirrors a Dovecot/cPanel-style fixture without SPECIAL-USE flags", async () => {
    const h = await setupIntegration("compat-cpanel-no-special-use");
    activeAccountIds.push(h.account.id);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        uidValidity: 71_001,
        messages: [
          makeTextMessage({ uid: 10, subject: "inbox", from: "a@example.test", to: "u@example.test", body: "inbox" })
        ]
      },
      {
        path: "Sent",
        delimiter: "/",
        uidValidity: 71_002,
        messages: []
      },
      {
        path: "Archive/2026",
        delimiter: "/",
        uidValidity: 71_003,
        messages: [
          makeTextMessage({ uid: 20, subject: "archive", from: "b@example.test", to: "u@example.test", body: "archive" })
        ]
      },
      {
        path: "Trash",
        delimiter: "/",
        uidValidity: 71_004,
        messages: [
          makeTextMessage({ uid: 30, subject: "trash", from: "c@example.test", to: "u@example.test", body: "trash" })
        ]
      }
    ];
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });

    const result = await engine.syncAccount(h.account.id, "manual");
    expect(result.outcome).toBe("success");

    const folderRows = await h.pool.query<{
      path: string;
      delimiter: string | null;
      tracked: boolean;
      excluded_reason: string | null;
      sync_priority: number;
    }>(
      `
      SELECT path, delimiter, tracked, excluded_reason, sync_priority
      FROM public.imap_folders
      WHERE account_id = $1
      ORDER BY path
      `,
      [h.account.id]
    );
    expect(folderRows.rows).toEqual([
      { path: "Archive/2026", delimiter: "/", tracked: true, excluded_reason: null, sync_priority: 100 },
      { path: "INBOX", delimiter: "/", tracked: true, excluded_reason: null, sync_priority: 1 },
      { path: "Sent", delimiter: "/", tracked: true, excluded_reason: null, sync_priority: 5 },
      { path: "Trash", delimiter: "/", tracked: false, excluded_reason: "excluded_trash", sync_priority: 100 }
    ]);

    const messageRows = await h.pool.query<{ folder_path: string; count: string }>(
      `
      SELECT folder_path, count(*)::text AS count
      FROM public.imap_messages
      WHERE account_id = $1
      GROUP BY folder_path
      ORDER BY folder_path
      `,
      [h.account.id]
    );
    expect(messageRows.rows).toEqual([
      { folder_path: "Archive/2026", count: "1" },
      { folder_path: "INBOX", count: "1" }
    ]);
  });

  it("mirrors a Cyrus/Rackspace-style dot-delimiter fixture with a verified duplicate alias", async () => {
    const h = await setupIntegration("compat-rackspace-dot-delimiter");
    activeAccountIds.push(h.account.id);
    await h.pool.query("UPDATE public.imap_accounts SET provider_profile = 'rackspace' WHERE id = $1", [h.account.id]);
    const sharedMessages = [
      makeTextMessage({ uid: 1, subject: "same-a", from: "a@example.test", to: "u@example.test", body: "a" }),
      makeTextMessage({ uid: 2, subject: "same-b", from: "b@example.test", to: "u@example.test", body: "b" })
    ];
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: ".",
        specialUse: "\\Inbox",
        uidValidity: 72_001,
        messages: sharedMessages
      },
      {
        path: "INBOX.INBOX",
        delimiter: ".",
        uidValidity: 72_001,
        messages: sharedMessages
      },
      {
        path: "Projects.Client",
        delimiter: ".",
        uidValidity: 72_002,
        messages: [
          makeTextMessage({ uid: 9, subject: "project", from: "p@example.test", to: "u@example.test", body: "project" })
        ]
      }
    ];
    const engine = h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } });

    const result = await engine.syncAccount(h.account.id, "manual");
    expect(result.outcome).toBe("success");

    const folderRows = await h.pool.query<{ path: string; delimiter: string | null; tracked: boolean; excluded_reason: string | null }>(
      `
      SELECT path, delimiter, tracked, excluded_reason
      FROM public.imap_folders
      WHERE account_id = $1
      ORDER BY path
      `,
      [h.account.id]
    );
    expect(folderRows.rows).toEqual([
      { path: "INBOX", delimiter: ".", tracked: true, excluded_reason: null },
      { path: "INBOX.INBOX", delimiter: ".", tracked: false, excluded_reason: "excluded_duplicate_alias:INBOX" },
      { path: "Projects.Client", delimiter: ".", tracked: true, excluded_reason: null }
    ]);
  });

  it("does not treat an empty LIST response as provider deletion", async () => {
    const h = await setupIntegration("compat-empty-list");
    activeAccountIds.push(h.account.id);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 73_001,
        messages: [
          makeTextMessage({ uid: 1, subject: "kept", from: "a@example.test", to: "u@example.test", body: "kept" })
        ]
      }
    ];

    const firstResult = await h.buildEngine({ folders, overrides: { INITIAL_SYNC_BATCH_SIZE: 50 } }).syncAccount(h.account.id, "manual");
    expect(firstResult.outcome).toBe("success");

    await forceFolderDiscovery(h.pool, h.account.id);
    const emptyListResult = await h.buildEngine({ folders: [] }).syncAccount(h.account.id, "manual");
    expect(emptyListResult.outcome).toBe("failed");
    expect(emptyListResult.errors.join("; ")).toMatch(/Provider returned no folders/);

    const folder = (
      await h.pool.query<{ status: string; tracked: boolean; deleted_messages: string }>(
        `
        SELECT f.status,
               f.tracked,
               (SELECT count(*)::text
                FROM public.imap_messages m
                WHERE m.account_id = f.account_id
                  AND m.folder_path = f.path
                  AND m.deleted_in_provider = true) AS deleted_messages
        FROM public.imap_folders f
        WHERE f.account_id = $1 AND f.path = 'INBOX'
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(folder).toEqual({ status: "ACTIVE", tracked: true, deleted_messages: "0" });
  });

  it("caps large raw MIME fetches instead of storing unbounded bodies", async () => {
    const h = await setupIntegration("compat-large-body");
    activeAccountIds.push(h.account.id);
    await h.pool.query("UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1", [h.account.id]);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 74_001,
        messages: [
          makeTextMessage({
            uid: 1,
            subject: "large",
            from: "a@example.test",
            to: "u@example.test",
            body: "x".repeat(4096)
          })
        ]
      }
    ];
    const engine = h.buildEngine({
      folders,
      overrides: {
        BODY_RAW_MAX_BYTES: 256,
        BODY_BACKFILL_BATCH_SIZE: 10,
        INITIAL_SYNC_BATCH_SIZE: 50
      }
    });

    const result = await engine.syncAccount(h.account.id, "manual");
    expect(result.outcome).toBe("success");
    expect(result.bodiesFetched).toBe(1);

    const body = (
      await h.pool.query<{ raw_bytes: string; raw_truncated: boolean; raw_mime_length: string }>(
        `
        SELECT b.raw_bytes::text, b.raw_truncated, octet_length(b.raw_mime)::text AS raw_mime_length
        FROM public.imap_message_bodies b
        JOIN public.imap_messages m ON m.id = b.message_id
        WHERE m.account_id = $1
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(body).toEqual({ raw_bytes: "256", raw_truncated: true, raw_mime_length: "256" });
  });

  it("caps fallback raw MIME downloads when fetchOne returns no source", async () => {
    const h = await setupIntegration("compat-large-body-download-fallback");
    activeAccountIds.push(h.account.id);
    await h.pool.query("UPDATE public.imap_accounts SET body_fetch_policy = 'immediate' WHERE id = $1", [h.account.id]);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 74_101,
        messages: [
          makeTextMessage({
            uid: 1,
            subject: "large fallback",
            from: "a@example.test",
            to: "u@example.test",
            body: "x".repeat(4096)
          })
        ]
      }
    ];
    const engine = h.buildEngine({
      folders,
      overrides: {
        BODY_RAW_MAX_BYTES: 256,
        BODY_BACKFILL_BATCH_SIZE: 10,
        INITIAL_SYNC_BATCH_SIZE: 50
      },
      clientFactory: async () => new NoSourceFixtureImapClient(folders)
    });

    const result = await engine.syncAccount(h.account.id, "manual");
    expect(result.outcome).toBe("success");
    expect(result.bodiesFetched).toBe(1);

    const body = (
      await h.pool.query<{ raw_bytes: string; raw_truncated: boolean; raw_mime_length: string }>(
        `
        SELECT b.raw_bytes::text, b.raw_truncated, octet_length(b.raw_mime)::text AS raw_mime_length
        FROM public.imap_message_bodies b
        JOIN public.imap_messages m ON m.id = b.message_id
        WHERE m.account_id = $1
        `,
        [h.account.id]
      )
    ).rows[0];
    expect(body).toEqual({ raw_bytes: "256", raw_truncated: true, raw_mime_length: "256" });
  });

  it("surfaces a transient provider disconnect as partial account health instead of skipping it", async () => {
    const h = await setupIntegration("compat-transient-disconnect");
    activeAccountIds.push(h.account.id);
    const folders: FixtureFolder[] = [
      {
        path: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        uidValidity: 75_001,
        messages: [
          makeTextMessage({ uid: 1, subject: "priority", from: "a@example.test", to: "u@example.test", body: "priority" })
        ]
      },
      {
        path: "Archive",
        delimiter: "/",
        uidValidity: 75_002,
        messages: [
          makeTextMessage({ uid: 2, subject: "later", from: "b@example.test", to: "u@example.test", body: "later" })
        ]
      }
    ];
    const engine = h.buildEngine({
      folders,
      clientFactory: async () => new DisconnectingFixtureImapClient(folders, "Archive")
    });

    const result = await engine.syncAccount(h.account.id, "manual");
    expect(result.outcome).toBe("partial_success");
    expect(result.errors.join("; ")).toMatch(/Archive: \[Error\] provider transient disconnect/);

    const account = (
      await h.pool.query<{ sync_state: string; sync_state_reason: string | null }>(
        `SELECT sync_state, sync_state_reason FROM public.imap_accounts WHERE id = $1`,
        [h.account.id]
      )
    ).rows[0];
    expect(account.sync_state).toBe("DEGRADED");
    expect(account.sync_state_reason).toMatch(/provider transient disconnect/);
  });
});
