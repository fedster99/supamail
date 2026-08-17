import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ImapFlow } from "imapflow";
import { getConfig } from "../src/config.js";
import { applyPublicMigrations, closePool, getPool } from "../src/db.js";
import { openInboxIdleSession } from "../src/inbox-idle.js";
import { MirrorRepository } from "../src/repository.js";
import { MirrorEngine } from "../src/sync-engine.js";

const execFileAsync = promisify(execFile);

const image = process.env.DOVECOT_IMAGE ?? "dovecot/dovecot:2.4.1";
const containerName = process.env.DOVECOT_CONTAINER ?? "supamail-dovecot-smoke";
const mailbox = process.env.DOVECOT_MAILBOX ?? "supamail-dovecot@example.test";
const password = process.env.DOVECOT_PASSWORD ?? "supamail-dovecot-password";
const containerImapPort = 31_143;

async function docker(args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, { maxBuffer: 1024 * 1024 });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
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

async function waitForImapReady(port: number, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const socket = await connectSocket(port);
    try {
      const banner = await Promise.race([
        once(socket, "data").then(([data]) => data.toString("utf8")),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for IMAP banner")), 2_000))
      ]);
      if (banner.includes("Dovecot ready")) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      socket.end();
    }
  }

  throw new Error(`Timed out waiting for Dovecot IMAP banner on 127.0.0.1:${port}`);
}

async function mappedPort(name: string): Promise<number> {
  const output = await docker(["port", name, `${containerImapPort}/tcp`]);
  const match = output.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/) ?? output.match(/:(\d+)/);
  if (!match) throw new Error(`Could not parse mapped Dovecot IMAP port from: ${output}`);
  return Number(match[1]);
}

function dovecotConfig(): string {
  return [
    "dovecot_config_version = 2.4.1",
    "dovecot_storage_version = 2.4.1",
    "protocols = imap",
    "listen = 0.0.0.0",
    "ssl = no",
    "auth_allow_cleartext = yes",
    "auth_mechanisms = plain",
    "default_internal_user = vmail",
    "default_internal_group = vmail",
    "default_login_user = vmail",
    "mail_driver = maildir",
    "mail_home = /srv/vmail/%{user | lower}",
    "mail_path = ~/mail",
    "mail_uid = vmail",
    "mail_gid = vmail",
    "namespace inbox {",
    "  inbox = yes",
    "  separator = /",
    "}",
    "passdb static {",
    `  password = ${password}`,
    "}",
    "service imap-login {",
    "  inet_listener imap {",
    `    port = ${containerImapPort}`,
    "  }",
    "}"
  ].join("\n");
}

async function createMaildir(root: string, folder: string): Promise<string> {
  const folderRoot = folder === "INBOX" ? root : path.join(root, `.${folder}`);
  await Promise.all([
    mkdir(path.join(folderRoot, "cur"), { recursive: true }),
    mkdir(path.join(folderRoot, "new"), { recursive: true }),
    mkdir(path.join(folderRoot, "tmp"), { recursive: true })
  ]);
  return folderRoot;
}

function plainMessage(id: string, subject: string, body: string, from = "sender@example.test", to = mailbox): string {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <dovecot-smoke-${id}@example.test>`,
    `Date: ${new Date(Date.now() - Number(id.replace(/\D/g, "") || 0) * 60_000).toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body
  ].join("\r\n");
}

function attachmentMessage(): string {
  const boundary = "supamail-dovecot-boundary";
  return [
    "From: archive-sender@example.test",
    `To: ${mailbox}`,
    "Subject: Dovecot smoke attachment",
    "Message-ID: <dovecot-smoke-attachment@example.test>",
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Dovecot smoke archive message with an attachment.",
    `--${boundary}`,
    "Content-Type: text/plain",
    "Content-Disposition: attachment; filename=\"dovecot-fixture.txt\"",
    "Content-Transfer-Encoding: base64",
    "",
    "RG92ZWNvdCBmaXh0dXJlIGF0dGFjaG1lbnQK",
    `--${boundary}--`
  ].join("\r\n");
}

async function seedMaildir(vmailRoot: string): Promise<void> {
  const accountRoot = path.join(vmailRoot, mailbox, "mail");
  const inbox = await createMaildir(accountRoot, "INBOX");
  const sent = await createMaildir(accountRoot, "Sent");
  const archive = await createMaildir(accountRoot, "Archive");
  const trash = await createMaildir(accountRoot, "Trash");

  await Promise.all([
    writeFile(path.join(inbox, "new", "1.eml"), plainMessage("1", "Dovecot smoke 1", "Dovecot INBOX message 1.")),
    writeFile(path.join(inbox, "new", "2.eml"), plainMessage("2", "Dovecot smoke 2", "Dovecot INBOX message 2.")),
    writeFile(
      path.join(sent, "new", "1.eml"),
      plainMessage("sent", "Dovecot smoke sent", "Dovecot Sent message.", mailbox, "sender@example.test")
    ),
    writeFile(path.join(archive, "new", "1.eml"), attachmentMessage()),
    writeFile(path.join(trash, "new", "1.eml"), plainMessage("trash", "Dovecot smoke trash", "This folder must stay excluded."))
  ]);

  await chmod(vmailRoot, 0o777);
  await execFileAsync("chmod", ["-R", "777", vmailRoot]);
}

async function startDovecot(tempDir: string): Promise<number> {
  const configPath = path.join(tempDir, "dovecot.conf");
  const vmailRoot = path.join(tempDir, "vmail");
  await writeFile(configPath, dovecotConfig());
  await seedMaildir(vmailRoot);

  await docker(["rm", "-f", containerName], true);
  await docker([
    "run",
    "-d",
    "--name",
    containerName,
    "--rm",
    "-p",
    `127.0.0.1::${containerImapPort}`,
    "-v",
    `${configPath}:/etc/dovecot/dovecot.conf:ro`,
    "-v",
    `${vmailRoot}:/srv/vmail`,
    image
  ]);

  const port = await mappedPort(containerName);
  await waitForPort(port);
  await waitForImapReady(port);
  return port;
}

async function countRows(accountId: string): Promise<{
  folders: number;
  messages: number;
  bodies: number;
  attachments: number;
  deletedMessages: number;
  trackedArchive: boolean;
  excludedTrash: boolean;
}> {
  const result = await getPool().query<{
    folders: string;
    messages: string;
    bodies: string;
    attachments: string;
    deleted_messages: string;
    tracked_archive: boolean;
    excluded_trash: boolean;
  }>(
    `
    SELECT
      (SELECT count(*)::text FROM public.imap_folders WHERE account_id = $1) AS folders,
      (SELECT count(*)::text FROM public.imap_messages WHERE account_id = $1) AS messages,
      (SELECT count(*)::text FROM public.imap_message_bodies b JOIN public.imap_messages m ON m.id = b.message_id WHERE m.account_id = $1) AS bodies,
      (SELECT count(*)::text FROM public.imap_attachments a JOIN public.imap_messages m ON m.id = a.message_id WHERE m.account_id = $1) AS attachments,
      (SELECT count(*)::text FROM public.imap_messages WHERE account_id = $1 AND deleted_in_provider = true) AS deleted_messages,
      EXISTS (SELECT 1 FROM public.imap_folders WHERE account_id = $1 AND path = 'Archive' AND excluded_reason IS NULL AND tracked = true) AS tracked_archive,
      EXISTS (SELECT 1 FROM public.imap_folders WHERE account_id = $1 AND path = 'Trash' AND excluded_reason = 'excluded_trash' AND tracked = false) AS excluded_trash
    `,
    [accountId]
  );
  const row = result.rows[0];

  return {
    folders: Number(row.folders),
    messages: Number(row.messages),
    bodies: Number(row.bodies),
    attachments: Number(row.attachments),
    deletedMessages: Number(row.deleted_messages),
    trackedArchive: row.tracked_archive,
    excludedTrash: row.excluded_trash
  };
}

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "supamail-dovecot-smoke-"));
  const pool = getPool();
  let accountId: string | null = null;

  try {
    const imapPort = await startDovecot(tempDir);
    await applyPublicMigrations(pool);
    const config = {
      ...getConfig(),
      BODY_FETCH_POLICY: "immediate" as const,
      BODY_BACKFILL_BATCH_SIZE: 10,
      INITIAL_SYNC_BATCH_SIZE: 10,
      INCREMENTAL_SYNC_BATCH_SIZE: 10,
      MAX_RR_FOLDERS_PER_CYCLE: 10,
      MAX_FLAG_SCANS_PER_CYCLE: 10,
      MAX_RECONCILES_PER_CYCLE: 10,
      CONNECT_TIMEOUT_MS: 10_000,
      IMAP_COMMAND_TIMEOUT_MS: 10_000,
      IMAP_FOLDER_STATUS_INTERVAL_MS: 3_000,
      IMAP_LIST_STATUS_ENABLED: true,
      IMAP_QRESYNC_ENABLED: true,
      IMAP_ALLOW_PRIVATE_HOSTS: true
    };
    const repository = new MirrorRepository(pool, config);
    const account = await repository.createAccount({
      emailAddress: mailbox,
      host: "127.0.0.1",
      port: imapPort,
      secure: false,
      username: mailbox,
      password,
      providerProfile: "generic-imap",
      bodyFetchPolicy: "immediate"
    });
    accountId = account.id;

    const engine = new MirrorEngine({ pool, config, repository });
    const result = await engine.syncAccount(account.id, "manual");
    await pool.query(
      `UPDATE public.imap_folders
       SET next_sync_due_at = now() - interval '1 second',
           next_flag_scan_at = now() - interval '1 second',
           next_reconcile_at = now() - interval '1 second'
       WHERE account_id = $1 AND tracked = true`,
      [account.id]
    );
    const cursorResult = await engine.syncAccount(account.id, "manual");
    if (cursorResult.outcome !== "success") {
      throw new Error("Dovecot smoke could not establish CONDSTORE cursors");
    }
    const counts = await countRows(account.id);
    const idleAccount = await repository.getAccount(account.id);
    if (!idleAccount) throw new Error("Dovecot smoke Mailbox Account disappeared");
    const opened = await openInboxIdleSession(pool, config, idleAccount);
    if (opened.status !== "ready") throw new Error("Dovecot did not advertise IDLE");
    const session = opened.session;
    if (session.folderProbeStrategy !== "list_status") {
      throw new Error("Dovecot smoke did not activate LIST-STATUS");
    }
    let archiveWakeLatencyMs: number | null = null;
    let archiveLiveResult: Awaited<ReturnType<MirrorEngine["syncAccount"]>> | null = null;
    const waitForWake = async (message: string) => {
      const waiting = session.wait();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const injector = new ImapFlow({
        host: "127.0.0.1",
        port: imapPort,
        secure: false,
        auth: { user: mailbox, pass: password },
        logger: false
      });
      await injector.connect();
      try {
        await injector.append("INBOX", Buffer.from(message));
      } finally {
        await injector.logout().catch(() => injector.close());
      }
      return await Promise.race([
        waiting,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("Timed out waiting for Dovecot IDLE wake")),
          8_000
        ))
      ]);
    };
    try {
      const firstWake = await waitForWake(
        plainMessage("3", "Dovecot IDLE 3", "First IDLE arrival.")
      );
      if (firstWake.status !== "wake" || firstWake.wake.kind !== "exists") {
        throw new Error("Dovecot did not produce the first EXISTS wake");
      }
      const liveResult = await engine.syncAccount(account.id, "scheduled", {
        liveInboxOnly: true,
        client: session.syncClient,
        clientAccountId: session.accountId,
        keepClientOpen: true
      });
      if (liveResult.outcome !== "success") {
        throw new Error("Same-session IDLE sync failed");
      }
      const archiveWaiting = session.wait();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const injector = new ImapFlow({
        host: "127.0.0.1",
        port: imapPort,
        secure: false,
        auth: { user: mailbox, pass: password },
        logger: false
      });
      await injector.connect();
      let mutationCompletedAt = 0;
      try {
        const archiveLock = await injector.getMailboxLock("Archive");
        const oldUids: number[] = [];
        try {
          for await (const message of injector.fetch("1:*", { uid: true })) {
            oldUids.push(message.uid);
          }
        } finally {
          archiveLock.release();
        }
        const appended = await injector.append(
          "Archive",
          Buffer.from(plainMessage("archive-2", "Dovecot STATUS Archive", "Archive replacement."))
        );
        if (!appended || appended.uid === undefined) {
          throw new Error("Dovecot did not return UIDPLUS data for Archive APPEND");
        }
        const mutationLock = await injector.getMailboxLock("Archive");
        try {
          await injector.messageFlagsAdd([appended.uid], ["\\Seen"], { uid: true });
          if (oldUids.length > 0) {
            await injector.messageDelete([oldUids[0]], { uid: true });
          }
        } finally {
          mutationLock.release();
        }
        mutationCompletedAt = Date.now();
      } finally {
        await injector.logout().catch(() => injector.close());
      }
      const archiveWake = await Promise.race([
        archiveWaiting,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("Timed out waiting for Archive STATUS wake")),
          8_000
        ))
      ]);
      archiveWakeLatencyMs = Date.now() - mutationCompletedAt;
      if (archiveWake.status !== "wake" || archiveWake.wake.folderPath !== "Archive") {
        throw new Error("Dovecot STATUS renewal did not identify Archive");
      }
      archiveLiveResult = await engine.syncAccount(account.id, "scheduled", {
        liveInboxOnly: true,
        client: session.syncClient,
        clientAccountId: session.accountId,
        keepClientOpen: true
      });
      if (archiveLiveResult.outcome !== "success") {
        throw new Error("Same-session Archive STATUS sync failed");
      }
      const secondWake = await waitForWake(
        plainMessage("4", "Dovecot IDLE 4", "Second IDLE arrival.")
      );
      if (secondWake.status !== "wake" || secondWake.wake.kind !== "exists") {
        throw new Error("Dovecot did not re-enter IDLE on the same session");
      }
    } finally {
      session.close();
    }
    const idleCounts = await countRows(account.id);
    const qresyncEvent = await pool.query<{
      payload: {
        accepted?: boolean;
        complete?: boolean;
        fallbackRequired?: boolean;
        vanishedUidCount?: number;
      };
    }>(
      `SELECT payload
       FROM public.imap_sync_events
       WHERE account_id = $1
         AND folder_path = 'Archive'
         AND event_type = 'QRESYNC_REPLAY'
       ORDER BY created_at DESC
       LIMIT 1`,
      [account.id]
    );
    const archiveQresync = qresyncEvent.rows[0]?.payload;
    const assertions: Array<[string, boolean]> = [
      ["sync succeeded", result.outcome === "success"],
      ["discovered Dovecot folders", counts.folders >= 4],
      ["mirrored non-excluded messages", counts.messages === 4],
      ["stored raw/parsed bodies", counts.bodies === 4],
      ["stored attachment metadata", counts.attachments >= 1],
      ["kept Archive trackable", counts.trackedArchive],
      ["excluded Trash by provider profile", counts.excludedTrash],
      ["no false provider deletes before live changes", counts.deletedMessages === 0],
      ["same-session IDLE and STATUS sync stored both arrivals", idleCounts.messages === 6],
      ["Archive STATUS sync reconciled the removed row", idleCounts.deletedMessages === 1],
      ["Archive STATUS wake stayed within one configured interval", archiveWakeLatencyMs !== null && archiveWakeLatencyMs < 4_500],
      ["Archive STATUS sync targeted one folder", archiveLiveResult?.foldersProcessed === 1],
      ["Archive replay used complete QRESYNC", archiveQresync?.accepted === true
        && archiveQresync.complete === true
        && archiveQresync.fallbackRequired === false
        && (archiveQresync.vanishedUidCount ?? 0) >= 1]
    ];
    const failed = assertions.filter(([, passed]) => !passed);
    if (failed.length > 0) {
      throw new Error(`Dovecot smoke failed: ${failed.map(([name]) => name).join(", ")}`);
    }

    console.log(JSON.stringify({
      ok: true,
      image,
      mailbox,
      imapPort,
      result,
      cursorResult,
      counts,
      idleCounts,
      archiveWakeLatencyMs,
      archiveLiveResult,
      archiveQresync
    }, null, 2));
  } finally {
    const keepData = process.env.SUPAMAIL_DOVECOT_KEEP_DATA === "true";
    if (!keepData && accountId) {
      await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
    }
    if (process.env.SUPAMAIL_DOVECOT_KEEP_CONTAINER !== "true") {
      await docker(["rm", "-f", containerName], true);
    }
    if (!keepData) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} finally {
  await closePool();
}
