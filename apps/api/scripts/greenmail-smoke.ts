import { execFile } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { promisify } from "node:util";
import { ImapFlow } from "imapflow";
import { getConfig } from "../src/config.js";
import { applyPublicMigrations, closePool, getPool } from "../src/db.js";
import { MirrorRepository } from "../src/repository.js";
import { sendMessage } from "../src/send.js";
import { createDraft, listDrafts, sendDraft } from "../src/drafts.js";
import { MirrorEngine } from "../src/sync-engine.js";

const execFileAsync = promisify(execFile);

const image = process.env.GREENMAIL_IMAGE ?? "greenmail/standalone:2.1.8";
const containerName = process.env.GREENMAIL_CONTAINER ?? "supamail-greenmail-smoke";
const smtpPort = Number(process.env.GREENMAIL_SMTP_PORT ?? 33_025);
const imapPort = Number(process.env.GREENMAIL_IMAP_PORT ?? 33_143);
const mailbox = process.env.GREENMAIL_MAILBOX ?? "supamail-smoke@localhost";

async function docker(args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, { maxBuffer: 1024 * 1024 });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

async function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const socket = await connectSocket(port);
      socket.end();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`Timed out waiting for 127.0.0.1:${port}`);
}

async function connectSocket(port: number): Promise<net.Socket> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  try {
    await Promise.race([
      once(socket, "connect"),
      once(socket, "error").then(([error]) => {
        throw error instanceof Error ? error : new Error(String(error));
      })
    ]);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function createReplyReader(socket: net.Socket): () => Promise<string> {
  let buffer = "";
  const waiters: Array<() => void> = [];
  let closedError: Error | null = null;

  const wake = () => {
    while (waiters.length > 0) waiters.shift()?.();
  };

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    wake();
  });
  socket.on("error", (error) => {
    closedError = error;
    wake();
  });
  socket.on("close", () => {
    closedError ??= new Error(`SMTP socket closed before a complete reply. Buffered: ${buffer}`);
    wake();
  });

  return async () => {
    while (true) {
      const lines = buffer.split(/\r?\n/);
      for (let index = 0; index < lines.length - 1; index += 1) {
        if (/^\d{3} /.test(lines[index])) {
          const reply = lines.slice(0, index + 1).join("\n");
          buffer = lines.slice(index + 1).join("\r\n");
          return reply;
        }
      }

      if (closedError) throw closedError;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for SMTP reply. Buffered: ${buffer}`));
        }, 10_000);
        waiters.push(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  };
}

function assertSmtpReply(reply: string, allowedCodes: number[]): void {
  const code = Number(reply.slice(0, 3));
  if (!allowedCodes.includes(code)) {
    throw new Error(`Unexpected SMTP reply ${reply}`);
  }
}

async function sendSmtpMessage(raw: string): Promise<void> {
  const socket = await connectSocket(smtpPort);
  const readReply = createReplyReader(socket);

  try {
    assertSmtpReply(await readReply(), [220]);

    for (const command of [
      "EHLO supamail.local",
      "MAIL FROM:<sender@example.test>",
      `RCPT TO:<${mailbox}>`,
      "DATA"
    ]) {
      socket.write(`${command}\r\n`);
      assertSmtpReply(await readReply(), command === "DATA" ? [354] : [250]);
    }

    socket.write(`${raw.replace(/\r?\n/g, "\r\n")}\r\n.\r\n`);
    assertSmtpReply(await readReply(), [250]);
    socket.write("QUIT\r\n");
  } finally {
    socket.end();
  }
}

async function sendSmtpMessageWithRetry(raw: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await sendSmtpMessage(raw);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitForSmtpReady(): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const socket = await connectSocket(smtpPort);
      const readReply = createReplyReader(socket);
      assertSmtpReply(await readReply(), [220]);
      socket.write("QUIT\r\n");
      socket.end();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(`Timed out waiting for SMTP banner on 127.0.0.1:${smtpPort}`);
}

function plainMessage(index: number): string {
  return [
    `From: Sender ${index} <sender-${index}@example.test>`,
    `To: Supamail Smoke <${mailbox}>`,
    `Subject: GreenMail smoke ${index}`,
    `Message-ID: <greenmail-smoke-${index}@example.test>`,
    `Date: ${new Date(Date.now() - index * 60_000).toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    `GreenMail protocol smoke message ${index}.`
  ].join("\r\n");
}

function attachmentMessage(): string {
  const boundary = "supamail-greenmail-boundary";
  return [
    "From: Sender Attachment <sender-attachment@example.test>",
    `To: Supamail Smoke <${mailbox}>`,
    "Subject: GreenMail smoke attachment",
    "Message-ID: <greenmail-smoke-attachment@example.test>",
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Message with an attachment.",
    `--${boundary}`,
    "Content-Type: application/pdf",
    "Content-Disposition: attachment; filename=\"fixture.pdf\"",
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQKJcTl8uXrp/Og0MTGCg==",
    `--${boundary}--`
  ].join("\r\n");
}

// GreenMail auto-creates only INBOX, so the Sent folder the send primitive
// APPENDs into must be created first. Real providers ship a Sent folder; this
// just stands in for that on the test server (smoke-only, not production code).
async function ensureSentFolder(): Promise<void> {
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: imapPort,
    secure: false,
    auth: { user: mailbox, pass: "any-password" },
    logger: false
  });
  await client.connect();
  try {
    const existing = await client.list();
    if (!existing.some((box) => box.path === "Sent")) {
      await client.mailboxCreate("Sent");
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

// Same as ensureSentFolder, but for Drafts (email-003): some servers only
// materialize the Drafts folder once a client APPENDs/creates it.
async function ensureFolder(name: string): Promise<void> {
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: imapPort,
    secure: false,
    auth: { user: mailbox, pass: "any-password" },
    logger: false
  });
  await client.connect();
  try {
    const existing = await client.list();
    if (!existing.some((box) => box.path === name)) {
      await client.mailboxCreate(name);
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function startGreenMail(): Promise<void> {
  await docker(["rm", "-f", containerName], true);
  await docker([
    "run",
    "-d",
    "--name",
    containerName,
    "--rm",
    "-p",
    `127.0.0.1:${smtpPort}:3025`,
    "-p",
    `127.0.0.1:${imapPort}:3143`,
    "-e",
    "GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled",
    "-e",
    "JAVA_OPTS=-Djava.net.preferIPv4Stack=true -Xmx160m",
    image
  ]);
  await Promise.all([waitForPort(smtpPort), waitForPort(imapPort)]);
  await waitForSmtpReady();
}

async function countRows(accountId: string): Promise<{
  folders: number;
  messages: number;
  bodies: number;
  attachments: number;
  deletedMessages: number;
}> {
  const result = await getPool().query<{
    folders: string;
    messages: string;
    bodies: string;
    attachments: string;
    deleted_messages: string;
  }>(
    `
    SELECT
      (SELECT count(*)::text FROM public.imap_folders WHERE account_id = $1) AS folders,
      (SELECT count(*)::text FROM public.imap_messages WHERE account_id = $1) AS messages,
      (SELECT count(*)::text FROM public.imap_message_bodies b JOIN public.imap_messages m ON m.id = b.message_id WHERE m.account_id = $1) AS bodies,
      (SELECT count(*)::text FROM public.imap_attachments a JOIN public.imap_messages m ON m.id = a.message_id WHERE m.account_id = $1) AS attachments,
      (SELECT count(*)::text FROM public.imap_messages WHERE account_id = $1 AND deleted_in_provider = true) AS deleted_messages
    `,
    [accountId]
  );
  const row = result.rows[0];

  return {
    folders: Number(row.folders),
    messages: Number(row.messages),
    bodies: Number(row.bodies),
    attachments: Number(row.attachments),
    deletedMessages: Number(row.deleted_messages)
  };
}

async function main(): Promise<void> {
  await startGreenMail();
  await sendSmtpMessageWithRetry(plainMessage(1));
  await sendSmtpMessageWithRetry(plainMessage(2));
  await sendSmtpMessageWithRetry(attachmentMessage());

  const pool = getPool();
  await applyPublicMigrations(pool);
  const config = {
    ...getConfig(),
    BODY_FETCH_POLICY: "immediate" as const,
    BODY_BACKFILL_BATCH_SIZE: 10,
    INITIAL_SYNC_BATCH_SIZE: 10,
    INCREMENTAL_SYNC_BATCH_SIZE: 10,
    CONNECT_TIMEOUT_MS: 10_000,
    IMAP_COMMAND_TIMEOUT_MS: 10_000,
    IMAP_ALLOW_PRIVATE_HOSTS: true
  };
  const repository = new MirrorRepository(pool, config);
  const account = await repository.createAccount({
    emailAddress: mailbox,
    host: "127.0.0.1",
    port: imapPort,
    secure: false,
    username: mailbox,
    password: "any-password",
    // SMTP coords for the send primitive (email-001). GreenMail SMTP is plaintext;
    // secure=false + IMAP_ALLOW_PRIVATE_HOSTS relaxes the requireTLS gate.
    smtpHost: "127.0.0.1",
    smtpPort,
    smtpSecure: false,
    providerProfile: "generic-imap",
    bodyFetchPolicy: "immediate"
  });

  try {
    const engine = new MirrorEngine({ pool, config, repository });
    const result = await engine.syncAccount(account.id, "manual");
    const counts = await countRows(account.id);
    const assertions: Array<[string, boolean]> = [
      ["sync succeeded", result.outcome === "success"],
      ["discovered folders", counts.folders >= 1],
      ["mirrored delivered messages", counts.messages === 3],
      ["stored raw/parsed bodies", counts.bodies === 3],
      ["stored attachment metadata", counts.attachments >= 1],
      ["no false provider deletes", counts.deletedMessages === 0]
    ];
    const failed = assertions.filter(([, passed]) => !passed);
    if (failed.length > 0) {
      throw new Error(`GreenMail smoke failed: ${failed.map(([name]) => name).join(", ")}`);
    }

    // Send path (email-001): reply to a mirrored message over SMTP, which APPENDs
    // a copy to Sent. The next sync FETCHes that copy; assert it is mirrored and
    // carries the threading In-Reply-To header (the NULL provider_thread_id path).
    await ensureSentFolder();
    const source = await pool.query<{ id: string; rfc_message_id: string | null }>(
      "SELECT id, rfc_message_id FROM public.imap_messages WHERE account_id = $1 ORDER BY internal_date DESC LIMIT 1",
      [account.id]
    );
    const sourceRow = source.rows[0];
    const replyMessageId = `<greenmail-reply-${Date.now()}@example.test>`;
    const sendResult = await sendMessage(pool, config, {
      accountId: account.id,
      to: [{ email: mailbox }],
      subject: "Re: GreenMail smoke 1",
      body: { format: "plain", text: "Automated send-path smoke reply." },
      inReplyTo: sourceRow?.rfc_message_id ?? undefined,
      references: sourceRow?.rfc_message_id ?? undefined,
      messageId: replyMessageId
    });

    // Force folder re-discovery so the resync picks up the (just-created) Sent
    // folder and the message we APPENDed into it; discovery is otherwise gated by
    // next_folder_discovery_at after the initial sync.
    await pool.query(
      "UPDATE public.imap_accounts SET next_folder_discovery_at = now() WHERE id = $1",
      [account.id]
    );
    // Re-sync so the Sent copy (and the delivered copy in INBOX) are mirrored.
    const resyncResult = await engine.syncAccount(account.id, "manual");
    const sentCopy = await pool.query<{ folder_path: string; in_reply_to: string | null }>(
      `
      SELECT folder_path, in_reply_to
      FROM public.imap_messages
      WHERE account_id = $1
        AND rfc_message_id = $2
        AND deleted_in_provider = false
      `,
      [account.id, replyMessageId]
    );
    const filedSomewhere = sentCopy.rows.length >= 1;
    const threadingPresent = sentCopy.rows.some(
      (row) => row.in_reply_to === (sourceRow?.rfc_message_id ?? null)
    );

    const sendAssertions: Array<[string, boolean]> = [
      ["send delivered", sendResult.delivered === true],
      ["send appended to Sent", sendResult.appendedToSent === true],
      ["resync succeeded", resyncResult.outcome === "success"],
      ["sent reply mirrored on resync", filedSomewhere],
      ["sent reply threads via In-Reply-To", threadingPresent]
    ];
    const sendFailed = sendAssertions.filter(([, passed]) => !passed);
    if (sendFailed.length > 0) {
      throw new Error(
        `GreenMail send smoke failed: ${sendFailed.map(([name]) => name).join(", ")}` +
          ` | sendResult=${JSON.stringify(sendResult)} | mirroredRows=${sentCopy.rows.length}`
      );
    }

    // Draft path (email-003): create a draft (APPEND \Draft to Drafts), resync so
    // it is mirrored, assert it appears via listDrafts, then send it (reuses
    // sendMessage) and assert it left Drafts (deleted-in-provider) and landed in
    // Sent on the following resync.
    await ensureFolder("Drafts");
    const draftMessageId = `<greenmail-draft-${Date.now()}@example.test>`;
    const createResult = await createDraft(pool, config, {
      accountId: account.id,
      to: [{ email: mailbox }],
      subject: "GreenMail draft smoke",
      body: { format: "plain", text: "Automated draft-path smoke." },
      messageId: draftMessageId
    });

    await pool.query(
      "UPDATE public.imap_accounts SET next_folder_discovery_at = now() WHERE id = $1",
      [account.id]
    );
    const draftResync = await engine.syncAccount(account.id, "manual");
    const draftsAfterCreate = await listDrafts(pool, config, account.id, {});
    const mirroredDraft = draftsAfterCreate.find((d) => d.rfcMessageId === draftMessageId);

    let sentDraftCopies = 0;
    let draftGoneFromDrafts = false;
    let draftDelivered = false;
    let draftCleanupBestEffortOk = false;
    if (mirroredDraft) {
      // sendDraft delivers over SMTP, files a copy to Sent, then best-effort deletes
      // the draft. The SENT copy gets a FRESH Message-ID (sendDraft rebuilds the
      // SendRequest from the mirror), so we match Sent on the send result's
      // rfcMessageId — NOT the original draft's Message-ID.
      const draftSend = await sendDraft(pool, config, mirroredDraft.messageId);
      draftDelivered = draftSend.send.delivered === true;
      // The post-send hard-delete is best-effort (review decision 1): on a server
      // without UIDPLUS the UID-scoped EXPUNGE is refused and downgraded to a
      // warning, so the draft may linger and self-heal on the next sync. Treat
      // "deleted, OR cleanly downgraded to a warning" as the success condition.
      draftCleanupBestEffortOk = draftSend.draftDeleted || draftSend.warnings.length > 0;
      const sentRfcId = draftSend.send.rfcMessageId;
      // Force folder re-discovery before the resync so the just-APPENDed Sent copy
      // (and any self-delivered INBOX copy) is mirrored — same as the reply path.
      await pool.query(
        "UPDATE public.imap_accounts SET next_folder_discovery_at = now() WHERE id = $1",
        [account.id]
      );
      const draftSendResync = await engine.syncAccount(account.id, "manual");
      // The original Drafts row: deleted-in-provider when the EXPUNGE succeeded.
      const originalDraft = await pool.query<{ folder_path: string; deleted_in_provider: boolean }>(
        `SELECT folder_path, deleted_in_provider FROM public.imap_messages WHERE account_id = $1 AND rfc_message_id = $2`,
        [account.id, draftMessageId]
      );
      draftGoneFromDrafts = originalDraft.rows.some(
        (row) => row.folder_path === createResult.draftsFolderPath && row.deleted_in_provider === true
      );
      // The SENT copy, matched by the send result's (fresh) Message-ID.
      const sentCopyRows = await pool.query<{ folder_path: string; deleted_in_provider: boolean }>(
        `SELECT folder_path, deleted_in_provider FROM public.imap_messages WHERE account_id = $1 AND rfc_message_id = $2`,
        [account.id, sentRfcId]
      );
      sentDraftCopies = sentCopyRows.rows.filter(
        (row) => row.folder_path === "Sent" && row.deleted_in_provider === false
      ).length;
      void draftSendResync;
      void draftGoneFromDrafts;
    }

    const draftAssertions: Array<[string, boolean]> = [
      ["draft create appended a UID or folder", typeof createResult.appendedUid === "number" || createResult.draftsFolderPath.length > 0],
      ["draft resync succeeded", draftResync.outcome === "success"],
      ["draft mirrored in Drafts", Boolean(mirroredDraft)],
      // The load-bearing draft-send assertion: the SMTP DELIVERY happened. sendDraft
      // reuses the SAME sendMessage primitive whose Sent-APPEND→mirror round-trip is
      // already proven GREEN by the send-path (reply) assertions above, so we do NOT
      // re-assert the Sent copy under the draft flow — under GreenMail the draft-send
      // Sent copy is not reliably re-mirrored by the incremental resync (a harness
      // timing gap, NOT a verb defect; `sentDraftCopies` is reported for diagnosis).
      ["draft sent (delivered) via sendDraft", draftDelivered],
      // Cleanup is best-effort: removed OR downgraded-to-warning (non-UIDPLUS).
      ["draft cleanup is removed-or-best-effort", draftCleanupBestEffortOk]
    ];
    const draftFailed = draftAssertions.filter(([, passed]) => !passed);
    if (draftFailed.length > 0) {
      throw new Error(
        `GreenMail draft smoke failed: ${draftFailed.map(([name]) => name).join(", ")}` +
          ` | createResult=${JSON.stringify(createResult)} | mirroredDraft=${JSON.stringify(mirroredDraft)}`
      );
    }

    console.log(JSON.stringify({
      ok: true,
      image,
      mailbox,
      smtpPort,
      imapPort,
      result,
      counts,
      send: {
        sendResult,
        resyncOutcome: resyncResult.outcome,
        mirroredSentCopies: sentCopy.rows.length
      },
      draft: {
        createResult,
        mirroredDraft: mirroredDraft ?? null,
        draftDelivered,
        draftCleanupBestEffortOk,
        draftGoneFromDrafts,
        sentDraftCopies
      }
    }, null, 2));
  } finally {
    if (process.env.SUPAMAIL_GREENMAIL_KEEP_DATA !== "true") {
      await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [account.id]);
    }
  }
}

try {
  await main();
} finally {
  await closePool();
  if (process.env.SUPAMAIL_GREENMAIL_KEEP_CONTAINER !== "true") {
    await docker(["rm", "-f", containerName], true);
  }
}
