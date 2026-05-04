import { getConfig } from "../src/config.js";
import { applyInitialMigration, closePool, getPool } from "../src/db.js";
import type {
  FetchMessage,
  MailboxListItem,
  MailboxLock,
  MailboxStatus,
  MirrorImapClient
} from "../src/imap-client.js";
import { MirrorRepository } from "../src/repository.js";
import { MirrorEngine } from "../src/sync-engine.js";

interface FixtureMessage {
  uid: number;
  subject: string;
  from: string;
  to: string;
  internalDate: Date;
  flags: string[];
  raw: Buffer;
  bodyStructure: unknown;
}

class FakeImapClient implements MirrorImapClient {
  mailbox: MailboxStatus | false | null = null;

  private readonly messagesByFolder = new Map<string, FixtureMessage[]>();

  constructor() {
    this.messagesByFolder.set("INBOX", [
      {
        uid: 101,
        subject: "Dry run hello",
        from: "alice@example.test",
        to: "dryrun@example.test",
        internalDate: new Date(Date.now() - 60 * 60_000),
        flags: ["\\Seen"],
        raw: rawMime({
          from: "Alice <alice@example.test>",
          to: "Dry Run <dryrun@example.test>",
          subject: "Dry run hello",
          messageId: "<dry-run-101@example.test>",
          body: "This is a fake local sync message."
        }),
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { part: "1", type: "text/plain", size: 34 },
            {
              part: "2",
              type: "application/pdf",
              size: 1234,
              disposition: { type: "attachment", params: { filename: "fixture.pdf" } }
            }
          ]
        }
      },
      {
        uid: 102,
        subject: "Dry run follow up",
        from: "bob@example.test",
        to: "dryrun@example.test",
        internalDate: new Date(Date.now() - 30 * 60_000),
        flags: [],
        raw: rawMime({
          from: "Bob <bob@example.test>",
          to: "Dry Run <dryrun@example.test>",
          subject: "Dry run follow up",
          messageId: "<dry-run-102@example.test>",
          body: "Second fake local sync message."
        }),
        bodyStructure: { part: "1", type: "text/plain", size: 31 }
      }
    ]);

    this.messagesByFolder.set("Sent", [
      {
        uid: 201,
        subject: "Dry run sent",
        from: "dryrun@example.test",
        to: "charlie@example.test",
        internalDate: new Date(Date.now() - 15 * 60_000),
        flags: ["\\Seen"],
        raw: rawMime({
          from: "Dry Run <dryrun@example.test>",
          to: "Charlie <charlie@example.test>",
          subject: "Dry run sent",
          messageId: "<dry-run-201@example.test>",
          body: "A fake sent message."
        }),
        bodyStructure: { part: "1", type: "text/plain", size: 20 }
      }
    ]);
  }

  async logout(): Promise<void> {}

  async list(): Promise<MailboxListItem[]> {
    return [
      { path: "INBOX", delimiter: "/", specialUse: "\\Inbox" },
      { path: "Sent", delimiter: "/", specialUse: "\\Sent" },
      { path: "Trash", delimiter: "/", specialUse: "\\Trash" }
    ];
  }

  async getMailboxLock(path: string): Promise<MailboxLock> {
    this.mailbox = {
      path,
      uidValidity: path === "Sent" ? 22_002 : 11_001,
      uidNext: Math.max(0, ...this.messagesFor(path).map((message) => message.uid)) + 1,
      exists: this.messagesFor(path).length
    };
    return { release: () => undefined };
  }

  async *fetch(
    range: string | number[] | Record<string, unknown>,
    query: Record<string, unknown>
  ): AsyncIterable<FetchMessage> {
    const messages = this.selectedMessages(range);
    const metadataRequested = Boolean(query.envelope || query.headers || query.bodyStructure);

    for (const message of messages) {
      yield metadataRequested ? this.toFetchMessage(message) : { uid: message.uid };
    }
  }

  async fetchOne(range: string): Promise<FetchMessage | false | null> {
    const uid = Number(range);
    const message = this.messagesForCurrentMailbox().find((candidate) => candidate.uid === uid);
    if (!message) return false;
    return {
      ...this.toFetchMessage(message),
      source: message.raw
    };
  }

  async download(): Promise<{ content: AsyncIterable<Buffer> }> {
    throw new Error("Fixture messages should be fetched through fetchOne().");
  }

  private selectedMessages(range: string | number[] | Record<string, unknown>): FixtureMessage[] {
    const messages = this.messagesForCurrentMailbox();
    if (Array.isArray(range)) {
      const wanted = new Set(range);
      return messages.filter((message) => wanted.has(message.uid));
    }

    if (typeof range === "object" && range.uid && typeof range.uid === "string") {
      const [startRaw, endRaw] = range.uid.split(":");
      const start = Number(startRaw);
      const end = Number(endRaw);
      return messages.filter((message) => message.uid >= start && message.uid <= end);
    }

    return messages;
  }

  private messagesForCurrentMailbox(): FixtureMessage[] {
    if (!this.mailbox || this.mailbox === false) return [];
    return this.messagesFor(this.mailbox.path);
  }

  private messagesFor(path: string): FixtureMessage[] {
    return this.messagesByFolder.get(path) ?? [];
  }

  private toFetchMessage(message: FixtureMessage): FetchMessage {
    return {
      uid: message.uid,
      internalDate: message.internalDate,
      size: message.raw.length,
      flags: new Set(message.flags),
      envelope: {
        messageId: `<dry-run-${message.uid}@example.test>`,
        subject: message.subject,
        from: [parseAddress(message.from)],
        to: [parseAddress(message.to)]
      },
      headers: Buffer.from(
        [
          `Message-ID: <dry-run-${message.uid}@example.test>`,
          "References: <dry-run-root@example.test>",
          "In-Reply-To: <dry-run-root@example.test>"
        ].join("\r\n")
      ),
      bodyStructure: message.bodyStructure
    };
  }
}

function parseAddress(address: string): { address: string; name: string } {
  return { address, name: address.split("@")[0] };
}

function rawMime(input: {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  body: string;
}): Buffer {
  return Buffer.from(
    [
      `From: ${input.from}`,
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      `Message-ID: ${input.messageId}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      input.body
    ].join("\r\n")
  );
}

async function main(): Promise<void> {
  const pool = getPool();
  await applyInitialMigration(pool);
  const config = {
    ...getConfig(),
    BODY_FETCH_POLICY: "immediate" as const,
    BODY_BACKFILL_BATCH_SIZE: 10,
    INITIAL_SYNC_BATCH_SIZE: 2,
    INCREMENTAL_SYNC_BATCH_SIZE: 2
  };

  const email = `dryrun-${Date.now()}@example.test`;
  const repository = new MirrorRepository(pool, config);

  const hooks = {
    folders: 0,
    messages: 0,
    bodies: 0,
    syncRuns: 0
  };

  const engine = new MirrorEngine({
    pool,
    config,
    repository,
    hooks: {
      onFolderChanged: () => {
        hooks.folders += 1;
      },
      onMessageUpsert: () => {
        hooks.messages += 1;
      },
      onBodyFetched: () => {
        hooks.bodies += 1;
      },
      onSyncRunCompleted: () => {
        hooks.syncRuns += 1;
      }
    },
    clientFactory: async () => new FakeImapClient()
  });

  const account = await repository.createAccount({
    emailAddress: email,
    host: "fake.imap.local",
    port: 993,
    secure: true,
    username: email,
    password: "not-used-in-dry-run",
    providerProfile: "generic-imap",
    bodyFetchPolicy: "immediate"
  });

  try {
    const firstSync = await engine.syncAccount(account.id, "manual");
    const secondSync = await engine.syncAccount(account.id, "manual");
    const counts = await pool.query<{
      accounts: string;
      folders: string;
      tracked_folders: string;
      messages: string;
      bodies: string;
      attachments: string;
      runs: string;
      deleted_messages: string;
    }>(
      `
      SELECT
        (SELECT count(*)::text FROM public.imap_accounts WHERE id = $1) AS accounts,
        (SELECT count(*)::text FROM public.imap_folders WHERE account_id = $1) AS folders,
        (SELECT count(*)::text FROM public.imap_folders WHERE account_id = $1 AND tracked = true) AS tracked_folders,
        (SELECT count(*)::text FROM public.imap_messages WHERE account_id = $1) AS messages,
        (SELECT count(*)::text FROM public.imap_message_bodies b JOIN public.imap_messages m ON m.id = b.message_id WHERE m.account_id = $1) AS bodies,
        (SELECT count(*)::text FROM public.imap_attachments a JOIN public.imap_messages m ON m.id = a.message_id WHERE m.account_id = $1) AS attachments,
        (SELECT count(*)::text FROM public.imap_sync_runs WHERE account_id = $1) AS runs,
        (SELECT count(*)::text FROM public.imap_messages WHERE account_id = $1 AND deleted_in_provider = true) AS deleted_messages
      `,
      [account.id]
    );

    const row = counts.rows[0];
    const assertions: Array<[string, boolean]> = [
      ["first sync succeeded", firstSync.outcome === "success"],
      ["second sync is idempotent", secondSync.outcome === "success" && secondSync.messagesUpserted === 0],
      ["created account", Number(row.accounts) === 1],
      ["discovered all fixture folders", Number(row.folders) === 3],
      ["excluded Trash from tracked folders", Number(row.tracked_folders) === 2],
      ["mirrored messages", Number(row.messages) === 3],
      ["stored raw/parsed bodies", Number(row.bodies) === 3],
      ["stored attachment metadata", Number(row.attachments) === 1],
      ["recorded sync runs", Number(row.runs) === 2],
      ["no false provider deletes", Number(row.deleted_messages) === 0],
      ["fired hooks", hooks.folders === 3 && hooks.messages === 3 && hooks.bodies === 3 && hooks.syncRuns === 2]
    ];

    const failed = assertions.filter(([, passed]) => !passed);
    if (failed.length > 0) {
      throw new Error(`Dry run failed: ${failed.map(([name]) => name).join(", ")}`);
    }

    console.log(JSON.stringify({
      ok: true,
      accountId: account.id,
      firstSync,
      secondSync,
      counts: row,
      hooks
    }, null, 2));
  } finally {
    if (process.env.SUPAMAIL_DRY_RUN_KEEP_DATA !== "true") {
      await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [account.id]);
    }
  }
}

try {
  await main();
} finally {
  await closePool();
}
