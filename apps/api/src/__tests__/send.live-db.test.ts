import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { closePool, getPool, type PgClient } from "../db.js";
import { AccountBusyError } from "../errors.js";
import { clearOrphanedLockForAccount, withAccountLock } from "../locks.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

const mocks = vi.hoisted(() => ({
  deliverSmtp: vi.fn(),
  appenderAppend: vi.fn(),
  appenderList: vi.fn(async () => [{ path: "Sent", specialUse: "\\Sent" }]),
  appenderLogout: vi.fn(async () => undefined),
  appenderClose: vi.fn(),
  getRawMime: vi.fn(),
  deleteMessage: vi.fn()
}));

vi.mock("../smtp-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../smtp-client.js")>();
  return {
    ...actual,
    deliverSmtp: mocks.deliverSmtp,
    resolveSmtpCreds: vi.fn(async () => ({
      host: "smtp.example.test",
      port: 465,
      secure: true,
      username: "sender@example.test",
      password: "secret"
    })),
    SentFolderAppender: {
      connect: vi.fn(async () => ({
        list: mocks.appenderList,
        append: mocks.appenderAppend,
        logout: mocks.appenderLogout,
        close: mocks.appenderClose
      }))
    }
  };
});

vi.mock("../host-validation.js", () => ({
  assertSafeSmtpTarget: vi.fn(async () => ({ isPrivateHost: false }))
}));

vi.mock("../content.js", () => ({
  getRawMime: mocks.getRawMime
}));

vi.mock("../mailbox-mutations.js", () => ({
  deleteMessage: mocks.deleteMessage
}));

const config = {
  IMAP_ENCRYPTION_KEY: "local-live-db-test-encryption-key",
  IMAP_ALLOW_PRIVATE_HOSTS: false,
  STALE_HEARTBEAT_MS: 200
} as AppConfig;
const ACCOUNT_EMAIL = `send-lock-live-${process.pid}@example.test`;
const SMTP_RECEIPT = {
  accepted: ["recipient@example.test"],
  rejected: [],
  response: "250 OK"
};

liveDb("send account lock (live DB)", () => {
  let pool: ReturnType<typeof getPool>;
  let accountId = "";
  let lockId = "";
  let draftId = "";

  async function anotherSessionCanAcquireLock(): Promise<boolean> {
    const client = await pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [lockId]
      );
      const acquired = result.rows[0]?.acquired ?? false;
      if (acquired) {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]);
      }
      return acquired;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    pool = getPool();
    const account = await pool.query<{ id: string; lock_id: string }>(
      `INSERT INTO public.imap_accounts (email_address, host, port, username, encrypted_password)
       VALUES ($1, 'imap.example.test', 993, $1, $2)
       RETURNING id, lock_id`,
      [ACCOUNT_EMAIL, Buffer.from([0])]
    );
    accountId = account.rows[0].id;
    lockId = account.rows[0].lock_id;
    await pool.query(
      `INSERT INTO public.imap_folders (account_id, path, special_use)
       VALUES ($1, 'Drafts', '\\Drafts')`,
      [accountId]
    );
    const draft = await pool.query<{ id: string }>(
      `INSERT INTO public.imap_messages (
         account_id, folder_path, uidvalidity, uid, internal_date, subject,
         from_email, to_emails, flags, rfc_message_id
       )
       VALUES ($1, 'Drafts', 100, 7, now(), 'Draft lock proof', $2, $3, $4, '<draft-lock@example.test>')
       RETURNING id`,
      [accountId, ACCOUNT_EMAIL, ["recipient@example.test"], ["\\Draft"]]
    );
    draftId = draft.rows[0].id;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deliverSmtp.mockResolvedValue(SMTP_RECEIPT);
    mocks.appenderAppend.mockResolvedValue({ uid: 42 });
    mocks.appenderList.mockResolvedValue([{ path: "Sent", specialUse: "\\Sent" }]);
    mocks.appenderLogout.mockResolvedValue(undefined);
    mocks.appenderClose.mockImplementation(() => undefined);
    mocks.getRawMime.mockResolvedValue({
      messageId: draftId,
      raw: Buffer.from("From: sender@example.test\r\nTo: recipient@example.test\r\n\r\nDraft body"),
      source: "mirror",
      truncated: false
    });
    mocks.deleteMessage.mockResolvedValue({
      messageId: draftId,
      fromFolder: "Drafts",
      mode: "expunge",
      trashFolder: null
    });
  });

  afterAll(async () => {
    if (accountId) await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    await closePool();
  });

  it("rejects before SMTP when another session already owns the account lock", async () => {
    const locker: PgClient = await pool.connect();
    await locker.query("SELECT pg_advisory_lock($1::bigint)", [lockId]);
    try {
      const { sendMessage } = await import("../send.js");
      await expect(
        sendMessage(pool, config, {
          accountId,
          to: [{ email: "recipient@example.test" }],
          subject: "Lock proof",
          body: { format: "plain", text: "Body" }
        })
      ).rejects.toBeInstanceOf(AccountBusyError);

      expect(mocks.deliverSmtp).not.toHaveBeenCalled();
      expect(mocks.appenderAppend).not.toHaveBeenCalled();
    } finally {
      await locker.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]);
      locker.release();
    }
  });

  it("keeps the real session lock held through delivery, APPEND, graceful teardown, then releases it", async () => {
    mocks.deliverSmtp.mockImplementationOnce(async () => {
      expect(await anotherSessionCanAcquireLock()).toBe(false);
      return SMTP_RECEIPT;
    });
    mocks.appenderAppend.mockImplementationOnce(async () => {
      expect(await anotherSessionCanAcquireLock()).toBe(false);
      return { uid: 42 };
    });
    mocks.appenderLogout.mockImplementationOnce(async () => {
      expect(await anotherSessionCanAcquireLock()).toBe(false);
    });

    const { sendMessage } = await import("../send.js");
    const result = await sendMessage(pool, config, {
      accountId,
      to: [{ email: "recipient@example.test" }],
      subject: "Lock proof",
      body: { format: "plain", text: "Body" }
    });

    expect(result.delivered).toBe(true);
    expect(result.appendedToSent).toBe(true);
    expect(await anotherSessionCanAcquireLock()).toBe(true);
  });

  it("keeps the real lock through fallback close and releases it afterward", async () => {
    mocks.appenderLogout.mockImplementationOnce(async () => {
      expect(await anotherSessionCanAcquireLock()).toBe(false);
      throw new Error("LOGOUT timed out");
    });
    mocks.appenderClose.mockImplementationOnce(async () => {
      expect(await anotherSessionCanAcquireLock()).toBe(false);
    });

    const { sendMessage } = await import("../send.js");
    const result = await sendMessage(pool, config, {
      accountId,
      to: [{ email: "recipient@example.test" }],
      subject: "Fallback lock proof",
      body: { format: "plain", text: "Body" }
    });

    expect(result.delivered).toBe(true);
    expect(mocks.appenderClose).toHaveBeenCalledTimes(1);
    expect(await anotherSessionCanAcquireLock()).toBe(true);
  });

  it("refreshes the heartbeat for the full send so stale-lock recovery cannot reap it", async () => {
    let releaseDelivery: () => void = () => undefined;
    const deliveryMayFinish = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let deliveryEntered: () => void = () => undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      deliveryEntered = resolve;
    });
    mocks.deliverSmtp.mockImplementationOnce(async () => {
      deliveryEntered();
      await deliveryMayFinish;
      return SMTP_RECEIPT;
    });

    const { sendMessage } = await import("../send.js");
    const pending = sendMessage(pool, config, {
      accountId,
      to: [{ email: "recipient@example.test" }],
      subject: "Heartbeat proof",
      body: { format: "plain", text: "Body" }
    });

    await deliveryStarted;
    try {
      await new Promise((resolve) => setTimeout(resolve, config.STALE_HEARTBEAT_MS * 2));
      expect(await clearOrphanedLockForAccount(pool, lockId, config.STALE_HEARTBEAT_MS)).toBe(false);
      expect(await anotherSessionCanAcquireLock()).toBe(false);
    } finally {
      releaseDelivery();
    }
    await expect(pending).resolves.toMatchObject({ delivered: true });
    expect(await anotherSessionCanAcquireLock()).toBe(true);
  });

  it("serializes draft-send and direct-send on the same account lock", async () => {
    let releaseDraftDelivery: () => void = () => undefined;
    const draftDeliveryMayFinish = new Promise<void>((resolve) => {
      releaseDraftDelivery = resolve;
    });
    let draftDeliveryEntered: () => void = () => undefined;
    const draftDeliveryStarted = new Promise<void>((resolve) => {
      draftDeliveryEntered = resolve;
    });
    mocks.deliverSmtp.mockImplementationOnce(async () => {
      draftDeliveryEntered();
      await draftDeliveryMayFinish;
      return SMTP_RECEIPT;
    });

    const { sendDraft } = await import("../drafts.js");
    const { sendMessage } = await import("../send.js");
    const pendingDraft = sendDraft(pool, config, draftId);
    await draftDeliveryStarted;
    try {
      await expect(
        sendMessage(pool, config, {
          accountId,
          to: [{ email: "recipient@example.test" }],
          subject: "Cross-path contention",
          body: { format: "plain", text: "Body" }
        })
      ).rejects.toBeInstanceOf(AccountBusyError);
      expect(mocks.deliverSmtp).toHaveBeenCalledTimes(1);
    } finally {
      releaseDraftDelivery();
    }
    await expect(pendingDraft).resolves.toMatchObject({ send: { delivered: true } });
    expect(await anotherSessionCanAcquireLock()).toBe(true);
  });

  it("evicts a session when unlock reports false so another real session can acquire", async () => {
    const realClient = await pool.connect();
    const wrappedClient = {
      query: async (query: string, params?: unknown[]) => {
        if (query.includes("pg_advisory_unlock")) {
          // Fault injection: do not execute the real unlock. Returning false must
          // force PoolClient.release(error), which destroys the still-locking session.
          return { rows: [{ unlocked: false }] };
        }
        return await realClient.query(query, params as never);
      },
      release: (error?: Error | boolean) => realClient.release(error)
    } as PgClient;
    const wrappedPool = { connect: async () => wrappedClient } as never;

    await expect(withAccountLock(wrappedPool, lockId, async () => "done")).rejects.toThrow(/unlock=false/i);
    expect(await anotherSessionCanAcquireLock()).toBe(true);
  });
});
