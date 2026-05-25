import { execFile } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { promisify } from "node:util";
import { getConfig } from "../src/config.js";
import { applyPublicMigrations, closePool, getPool } from "../src/db.js";
import { MirrorRepository } from "../src/repository.js";
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

    console.log(JSON.stringify({
      ok: true,
      image,
      mailbox,
      smtpPort,
      imapPort,
      result,
      counts
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
