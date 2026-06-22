#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { Command } from "commander";
import { getConfig } from "./config.js";
import {
  cleanMessageBody,
  downloadAttachment,
  getMessageHeaders,
  getRawMime,
  listAttachments
} from "./content.js";
import { applyPublicMigrations, closePool, getPool } from "./db.js";
import { MirrorRepository } from "./repository.js";
import { MirrorEngine } from "./sync-engine.js";
import { searchMessages } from "./search/index.js";
import type { SearchRequest, SearchSort } from "./search/index.js";
import { runDraftReply, runListFolders, runReadMessage, runReadThread } from "./mcp/index.js";
import { sendMessage } from "./send.js";
import {
  createDraft,
  deleteDraft,
  getDraft,
  listDrafts,
  sendDraft,
  updateDraft
} from "./drafts.js";
import {
  createFolder,
  deleteFolder,
  deleteMessage,
  moveMessage,
  moveThread,
  renameFolder,
  setMessageFlags,
  setThreadFlags
} from "./mailbox-mutations.js";
import type { SendAttachment, SendRecipient, SendRequest, WindowStatus } from "./types.js";

const program = new Command();
const config = getConfig();
const pool = getPool();
const repository = new MirrorRepository(pool, config);
const engine = new MirrorEngine({ pool, config, repository });

program
  .name("supamail")
  .description("Supabase/Postgres-native IMAP mirror")
  .version("0.1.0");

program
  .command("migrate")
  .description("Apply public SupaMail mirror migrations")
  .action(async () => {
    await applyPublicMigrations(pool);
    console.log("Public migrations applied");
  });

program
  .command("create-account")
  .description("Create an IMAP account")
  .requiredOption("--email <email>", "Mailbox email address")
  .requiredOption("--host <host>", "IMAP host")
  .requiredOption("--port <port>", "IMAP port")
  .requiredOption("--username <username>", "IMAP username")
  .requiredOption("--password <password>", "IMAP password")
  .option("--profile <profile>", "Provider profile", "generic-imap")
  .option("--insecure", "Use plaintext IMAP instead of TLS")
  .option("--body-policy <policy>", "immediate, lazy, or priority_then_backfill")
  .option("--smtp-host <host>", "SMTP host (defaults to provider profile or omitted)")
  .option("--smtp-port <port>", "SMTP port (e.g. 465 implicit TLS, 587 STARTTLS)")
  .option("--smtp-insecure", "Use STARTTLS (port 587) instead of implicit TLS")
  .option("--smtp-username <username>", "SMTP username (defaults to IMAP username)")
  .option("--smtp-password <password>", "SMTP password (defaults to IMAP password)")
  .action(async (options) => {
    const account = await repository.createAccount({
      emailAddress: options.email,
      host: options.host,
      port: Number(options.port),
      secure: !options.insecure,
      username: options.username,
      password: options.password,
      smtpHost: options.smtpHost,
      smtpPort: options.smtpPort === undefined ? undefined : Number(options.smtpPort),
      smtpSecure: options.smtpHost ? !options.smtpInsecure : undefined,
      smtpUsername: options.smtpUsername,
      smtpPassword: options.smtpPassword,
      providerProfile: options.profile,
      bodyFetchPolicy: options.bodyPolicy
    });
    console.log(JSON.stringify(account, null, 2));
  });

program
  .command("list-accounts")
  .description("List configured IMAP accounts")
  .action(async () => {
    const accounts = await repository.listAccounts();
    console.log(JSON.stringify(accounts, null, 2));
  });

program
  .command("sync")
  .description("Trigger one account sync")
  .requiredOption("--account-id <id>", "Account UUID")
  .action(async (options) => {
    const result = await engine.syncAccount(options.accountId, "manual");
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("refetch-body")
  .description("Refetch and overwrite one message body")
  .requiredOption("--message-id <id>", "Message UUID")
  .action(async (options) => {
    const fetched = await engine.fetchBody(options.messageId, true);
    console.log(JSON.stringify({ fetched }, null, 2));
  });

const collect = (value: string, previous: string[]): string[] => {
  previous.push(value);
  return previous;
};

program
  .command("search [query...]")
  .description("Search mirrored email (read-only, JSON output)")
  .option("--account <id>", "Scope to account UUID (repeatable)", collect, [])
  .option("--from <addr>", "Sender contains (use @domain for the sender domain)")
  .option("--to <addr>", "Recipient (to/cc) contains")
  .option("--subject <text>", "Subject contains")
  .option("--body <text>", "Body full-text match")
  .option("--folder <path>", "Folder path (in:)")
  .option("--thread <id>", "Provider thread id")
  .option("--filename <glob>", "Attachment filename glob (e.g. *.pdf)")
  .option("--filetype <class>", "Attachment class (pdf,image,video,audio,doc,sheet,zip,text)")
  .option("--is <flag>", "Flag state read|unread|flagged|answered|draft (repeatable)", collect, [])
  .option("--has-attachment", "Only messages with an attachment")
  .option("--without-attachment", "Only messages without an attachment")
  .option("--after <when>", "After date (ISO like 2026-01-01 or relative like 7d)")
  .option("--before <when>", "Before date (ISO or relative)")
  .option("--larger <size>", "Larger than (e.g. 2mb, 500kb)")
  .option("--smaller <size>", "Smaller than")
  .option("--window <lane>", "Lane IN_WINDOW|EXPIRED|HISTORICAL (repeatable)", collect, [])
  .option("--include-deleted", "Include soft-deleted messages")
  .option("--sort <mode>", "smart|relevance|recent|oldest|size|sender")
  .option("--limit <n>", "Maximum results (1-100)", "25")
  .option("--offset <n>", "Result offset for pagination", "0")
  .option("--no-snippet", "Disable highlighted snippets")
  .option("--include-body", "Include full body text in each result")
  .option("--explain", "Include the per-result score breakdown")
  .action(async (queryWords: string[], options) => {
    const qParts: string[] = [];
    if (queryWords?.length) qParts.push(queryWords.join(" "));
    const addOp = (op: string, value: unknown): void => {
      if (value === undefined || value === null) return;
      const v = String(value);
      qParts.push(/\s/.test(v) ? `${op}:"${v}"` : `${op}:${v}`);
    };
    addOp("from", options.from);
    addOp("to", options.to);
    addOp("subject", options.subject);
    addOp("body", options.body);
    addOp("in", options.folder);
    addOp("thread", options.thread);
    addOp("filename", options.filename);
    addOp("filetype", options.filetype);
    addOp("after", options.after);
    addOp("before", options.before);
    addOp("larger", options.larger);
    addOp("smaller", options.smaller);
    for (const flag of (options.is as string[]) ?? []) qParts.push(`is:${flag}`);
    if (options.hasAttachment) qParts.push("has:attachment");
    if (options.withoutAttachment) qParts.push("-has:attachment");

    const accounts = options.account as string[];
    const windows = options.window as string[];
    const request: SearchRequest = {
      q: qParts.length > 0 ? qParts.join(" ") : undefined,
      accounts: accounts.length > 0 ? accounts : undefined,
      windowStatus: windows.length > 0 ? (windows as WindowStatus[]) : undefined,
      includeDeleted: Boolean(options.includeDeleted),
      sort: options.sort as SearchSort | undefined,
      limit: Number(options.limit),
      offset: Number(options.offset),
      snippet: options.snippet,
      includeBody: Boolean(options.includeBody),
      explain: Boolean(options.explain)
    };

    const response = await searchMessages(pool, request);
    console.log(JSON.stringify(response, null, 2));
  });

program
  .command("message <messageId>")
  .description("Read one mirrored message (read-only, JSON output)")
  .option("--headers", "Include parsed select headers")
  .option("--include-quoted", "Keep the quoted reply tail + signature")
  .action(async (messageId: string, options) => {
    const result = await runReadMessage(pool, {
      message_id: messageId,
      include_headers: Boolean(options.headers),
      include_quoted: Boolean(options.includeQuoted)
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("thread [messageId]")
  .description("Read a full email thread, seeded from a message id (read-only, JSON output)")
  .option("--thread-id <id>", "Select the thread directly by provider_thread_id")
  .option("--account <id>", "Scope the thread to one account UUID")
  .option("--include-quoted", "Keep quoted reply tails + signatures in each body")
  .option("--max-messages <n>", "Max messages to return, newest kept when over the cap")
  .action(async (messageId: string | undefined, options) => {
    if (!messageId && !options.threadId) {
      process.stderr.write("thread requires a messageId argument or --thread-id <id>.\n");
      process.exitCode = 1;
      return;
    }
    const result = await runReadThread(pool, {
      message_id: messageId ?? undefined,
      thread_id: options.threadId,
      account: options.account,
      include_quoted: Boolean(options.includeQuoted),
      max_messages: options.maxMessages === undefined ? undefined : Number(options.maxMessages)
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("folders")
  .description("List mailbox folders with live counts (read-only, JSON output)")
  .option("--account <id>", "Scope to one account UUID")
  .action(async (options) => {
    const result = await runListFolders(pool, { account: options.account });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("draft-reply <sourceMessageId>")
  .description("Produce a reply draft from a source message (produce-only, never sends)")
  .requiredOption("--body <text>", "The reply text the agent wrote")
  .option("--reply-all", "Include the original To+Cc (minus self) as Cc")
  .action(async (sourceMessageId: string, options) => {
    const result = await runDraftReply(pool, {
      source_message_id: sourceMessageId,
      body: options.body,
      reply_all: Boolean(options.replyAll)
    });
    console.log(JSON.stringify(result, null, 2));
  });

const parseRecipients = (values: string[]): SendRecipient[] =>
  values.map((value) => {
    const match = value.match(/^\s*(.*?)\s*<\s*([^>]+?)\s*>\s*$/);
    if (match) return { name: match[1] || undefined, email: match[2] };
    return { email: value.trim() };
  });

// The operator IS the human-in-the-loop, so the explicit --confirm flag is the
// send gate (no token dance, unlike the cloud MCP two-phase confirm). Both verbs
// refuse without it and call the shared sendMessage primitive.
// Read a `--attach path` (and `--inline cid=path`) option list into base64 attachments.
const readAttachments = async (attach: string[], inline: string[]): Promise<SendAttachment[]> => {
  const out: SendAttachment[] = [];
  for (const path of attach) {
    const bytes = await readFile(path);
    out.push({ filename: basename(path), content: bytes.toString("base64") });
  }
  for (const spec of inline) {
    // `cid=path` (or just `path`, defaulting the cid to the filename).
    const eq = spec.indexOf("=");
    const cid = eq > 0 ? spec.slice(0, eq) : undefined;
    const path = eq > 0 ? spec.slice(eq + 1) : spec;
    const bytes = await readFile(path);
    out.push({ filename: basename(path), content: bytes.toString("base64"), cid: cid ?? basename(path), inline: true });
  }
  return out;
};

program
  .command("send")
  .description("Compose and send a new message over SMTP, filing a copy to Sent (requires --confirm)")
  .requiredOption("--account-id <id>", "Account UUID to send from")
  .requiredOption("--to <addr>", "Recipient (repeatable; 'Name <email>' or 'email')", collect, [])
  .requiredOption("--subject <text>", "Subject line")
  .requiredOption("--body <text>", "Plain-text body")
  .option("--cc <addr>", "Cc recipient (repeatable)", collect, [])
  .option("--bcc <addr>", "Bcc recipient (repeatable)", collect, [])
  .option("--attach <path>", "Attach a file (repeatable)", collect, [])
  .option("--inline <cid=path>", "Inline image as cid=path (repeatable; referenced as cid:<cid>)", collect, [])
  .option("--html <html>", "HTML body (sent as HTML; required for inline cid: images)")
  .option("--confirm", "Required human confirmation; without it nothing is sent")
  .action(async (options) => {
    if (!options.confirm) {
      process.stderr.write("Refusing to send without --confirm.\n");
      process.exitCode = 1;
      return;
    }
    const attachments = await readAttachments(options.attach as string[], options.inline as string[]);
    const request: SendRequest = {
      accountId: options.accountId,
      to: parseRecipients(options.to as string[]),
      cc: (options.cc as string[]).length > 0 ? parseRecipients(options.cc as string[]) : undefined,
      bcc: (options.bcc as string[]).length > 0 ? parseRecipients(options.bcc as string[]) : undefined,
      subject: options.subject,
      body: options.html ? { format: "html", html: options.html } : { format: "plain", text: options.body },
      attachments: attachments.length > 0 ? attachments : undefined
    };
    const result = await sendMessage(pool, config, request);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("reply <sourceMessageId>")
  .description("Reply to a mirrored message over SMTP with correct threading (requires --confirm)")
  .requiredOption("--body <text>", "The reply text")
  .option("--reply-all", "Include the original To+Cc (minus self) as Cc")
  .option("--confirm", "Required human confirmation; without it nothing is sent")
  .action(async (sourceMessageId: string, options) => {
    if (!options.confirm) {
      process.stderr.write("Refusing to send without --confirm.\n");
      process.exitCode = 1;
      return;
    }
    // Resolve which account to send from BEFORE producing the draft: the reply
    // must go out from the mailbox the source message belongs to.
    const source = await repository.getMessage(sourceMessageId);
    if (!source) {
      process.stderr.write(`No mirrored message with id ${sourceMessageId}.\n`);
      process.exitCode = 1;
      return;
    }
    // Reuse the produce-only draft (correct To/Cc/Subject + threading headers,
    // incl. the NULL provider_thread_id generic-IMAP path) and just send it.
    const draft = await runDraftReply(pool, {
      source_message_id: sourceMessageId,
      body: options.body,
      reply_all: Boolean(options.replyAll)
    });
    if ("error" in draft) {
      console.log(JSON.stringify(draft, null, 2));
      process.exitCode = 1;
      return;
    }
    const request: SendRequest = {
      accountId: source.account_id,
      to: draft.to,
      cc: draft.cc.length > 0 ? draft.cc : undefined,
      subject: draft.subject,
      body: { format: "plain", text: draft.body.text },
      inReplyTo: draft.headers["In-Reply-To"],
      references: draft.headers.References
    };
    const result = await sendMessage(pool, config, request);
    console.log(JSON.stringify(result, null, 2));
  });

// Draft CRUD (email-003, ADR 0019). Create/update/list/get/delete/send drafts
// saved to the provider Drafts folder. Mostly composition: create APPENDs `\Draft`
// (reuses email-001 buildRawMime + appender), update = append-new + delete-old,
// send-draft reuses sendMessage. delete + send-draft refuse without --confirm
// (send is outward-facing — mirror the send/reply gate).
program
  .command("draft-create")
  .description("Create a draft saved to the provider Drafts folder")
  .requiredOption("--account-id <id>", "Account UUID to file the draft under")
  .option("--to <addr>", "Recipient (repeatable; 'Name <email>' or 'email')", collect, [])
  .option("--cc <addr>", "Cc recipient (repeatable)", collect, [])
  .option("--subject <text>", "Subject line", "")
  .option("--body <text>", "Plain-text body", "")
  .action(async (options) => {
    // No --bcc: Bcc can't round-trip through the saved draft bytes, so it is a
    // send-time-only field (set it on `send`/`reply`). See ADR 0019.
    const result = await createDraft(pool, config, {
      accountId: options.accountId,
      to: parseRecipients(options.to as string[]),
      cc: (options.cc as string[]).length > 0 ? parseRecipients(options.cc as string[]) : undefined,
      subject: options.subject,
      body: { format: "plain", text: options.body }
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("drafts <accountId>")
  .description("List drafts from the mirror (read-only, JSON output)")
  .option("--limit <n>", "Maximum results (1-200)", "50")
  .action(async (accountId: string, options) => {
    const result = await listDrafts(pool, config, accountId, { limit: Number(options.limit) });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("draft <messageId>")
  .description("Get one draft with its body from the mirror (read-only, JSON output)")
  .action(async (messageId: string) => {
    const result = await getDraft(pool, config, messageId);
    if (!result) {
      process.stderr.write(`No mirrored draft with id ${messageId}.\n`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("draft-update <messageId>")
  .description("Update a draft (append-new + delete-old; IMAP drafts are immutable)")
  .option("--to <addr>", "Recipient (repeatable)", collect, [])
  .option("--cc <addr>", "Cc recipient (repeatable)", collect, [])
  .option("--subject <text>", "Subject line", "")
  .option("--body <text>", "Plain-text body", "")
  .action(async (messageId: string, options) => {
    // No --bcc: Bcc is a send-time-only field, not a saved-draft field. See ADR 0019.
    const result = await updateDraft(pool, config, messageId, {
      to: parseRecipients(options.to as string[]),
      cc: (options.cc as string[]).length > 0 ? parseRecipients(options.cc as string[]) : undefined,
      subject: options.subject,
      body: { format: "plain", text: options.body }
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("draft-send <messageId>")
  .description("Send a saved draft over SMTP, then delete it from Drafts (requires --confirm)")
  .option("--confirm", "Required human confirmation; without it nothing is sent")
  .action(async (messageId: string, options) => {
    if (!options.confirm) {
      process.stderr.write("Refusing to send a draft without --confirm.\n");
      process.exitCode = 1;
      return;
    }
    const result = await sendDraft(pool, config, messageId);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("draft-delete <messageId>")
  .description("Delete a draft: move to Trash by default, or EXPUNGE with --hard (requires --confirm)")
  .option("--hard", "Permanently delete (EXPUNGE) instead of moving to Trash")
  .option("--confirm", "Required confirmation for this destructive op")
  .action(async (messageId: string, options) => {
    if (!options.confirm) {
      process.stderr.write("Refusing to delete a draft without --confirm.\n");
      process.exitCode = 1;
      return;
    }
    const result = await deleteDraft(pool, config, messageId, { hard: Boolean(options.hard) });
    console.log(JSON.stringify(result, null, 2));
  });

// Organize mutations (email-002, ADR 0018). Non-destructive verbs (mark/star/
// move) need no --confirm; destructive verbs (delete/hard-delete, folder delete)
// refuse without --confirm. All emit JSON, addressing the message by mirror id and
// acting on IMAP by UID; the next sync reconciles the mirror.
program
  .command("flag <messageId>")
  .description("Add/remove IMAP flags on a message (e.g. seen, flagged) — non-destructive")
  .option("--add <flag>", "Flag to add (seen|flagged|... repeatable)", collect, [])
  .option("--remove <flag>", "Flag to remove (repeatable)", collect, [])
  .action(async (messageId: string, options) => {
    const add = options.add as string[];
    const remove = options.remove as string[];
    if (add.length === 0 && remove.length === 0) {
      process.stderr.write("flag requires at least one --add or --remove.\n");
      process.exitCode = 1;
      return;
    }
    const result = await setMessageFlags(pool, config, messageId, { add, remove });
    console.log(JSON.stringify(result, null, 2));
  });

const markVerb = (flag: string, present: boolean) =>
  present ? { add: [flag] } : { remove: [flag] };

program
  .command("mark-read <messageId>")
  .description("Mark a message read (STORE +\\Seen) — non-destructive")
  .option("--unread", "Mark unread instead (STORE -\\Seen)")
  .action(async (messageId: string, options) => {
    const result = await setMessageFlags(pool, config, messageId, markVerb("seen", !options.unread));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("star <messageId>")
  .description("Star a message (STORE +\\Flagged) — non-destructive")
  .option("--unstar", "Unstar instead (STORE -\\Flagged)")
  .action(async (messageId: string, options) => {
    const result = await setMessageFlags(pool, config, messageId, markVerb("flagged", !options.unstar));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("move <messageId> <folder>")
  .description("Move a message to another folder — non-destructive")
  .action(async (messageId: string, folder: string) => {
    const result = await moveMessage(pool, config, messageId, folder);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("delete <messageId>")
  .description("Delete a message: move to Trash by default, or EXPUNGE with --hard (requires --confirm)")
  .option("--hard", "Permanently delete (STORE +\\Deleted then EXPUNGE) instead of moving to Trash")
  .option("--confirm", "Required confirmation for this destructive op")
  .action(async (messageId: string, options) => {
    if (!options.confirm) {
      process.stderr.write("Refusing to delete without --confirm.\n");
      process.exitCode = 1;
      return;
    }
    const result = await deleteMessage(pool, config, messageId, { hard: Boolean(options.hard) });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("thread-flag <messageId>")
  .description("Add/remove flags on every message in a thread — non-destructive")
  .option("--add <flag>", "Flag to add (repeatable)", collect, [])
  .option("--remove <flag>", "Flag to remove (repeatable)", collect, [])
  .action(async (messageId: string, options) => {
    const add = options.add as string[];
    const remove = options.remove as string[];
    if (add.length === 0 && remove.length === 0) {
      process.stderr.write("thread-flag requires at least one --add or --remove.\n");
      process.exitCode = 1;
      return;
    }
    const result = await setThreadFlags(pool, config, messageId, { add, remove });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("thread-move <messageId> <folder>")
  .description("Move every message in a thread to a folder — non-destructive")
  .action(async (messageId: string, folder: string) => {
    const result = await moveThread(pool, config, messageId, folder);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("folder-create <accountId> <path>")
  .description("Create a mailbox folder — non-destructive")
  .action(async (accountId: string, path: string) => {
    const result = await createFolder(pool, config, accountId, path);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("folder-rename <accountId> <path> <newPath>")
  .description("Rename a mailbox folder — non-destructive")
  .action(async (accountId: string, path: string, newPath: string) => {
    const result = await renameFolder(pool, config, accountId, path, newPath);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("folder-delete <accountId> <path>")
  .description("Delete a mailbox folder (requires --confirm)")
  .option("--confirm", "Required confirmation for this destructive op")
  .action(async (accountId: string, path: string, options) => {
    if (!options.confirm) {
      process.stderr.write("Refusing to delete a folder without --confirm.\n");
      process.exitCode = 1;
      return;
    }
    const result = await deleteFolder(pool, config, accountId, path);
    console.log(JSON.stringify(result, null, 2));
  });

// Attachment + content reads (email-004, ADR 0020). Metadata / clean body /
// headers read the mirror; attachment-download + raw (under parsed_only) do an
// on-demand read-only IMAP fetch. All read-only; all JSON except the byte streams.
program
  .command("attachments <messageId>")
  .description("List a message's attachment metadata from the mirror (read-only, JSON output)")
  .action(async (messageId: string) => {
    const result = await listAttachments(pool, config, messageId);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("attachment-download <attachmentId>")
  .description("Download an attachment's bytes (on-demand IMAP fetch); writes to --out or stdout base64")
  .option("--out <path>", "Write the decoded bytes to this file (else base64 to stdout)")
  .action(async (attachmentId: string, options) => {
    const download = await downloadAttachment(pool, config, attachmentId);
    if (options.out) {
      await writeFile(options.out, download.content);
      console.log(JSON.stringify({
        attachmentId: download.attachmentId,
        filename: download.filename,
        contentType: download.contentType,
        bytes: download.content.length,
        out: options.out
      }, null, 2));
    } else {
      process.stdout.write(download.content.toString("base64"));
      process.stdout.write("\n");
    }
  });

program
  .command("raw <messageId>")
  .description("Output a message's raw MIME (mirror if stored, else on-demand IMAP fetch); --out or stdout")
  .option("--out <path>", "Write the raw bytes to this file (else raw to stdout)")
  .action(async (messageId: string, options) => {
    const result = await getRawMime(pool, config, messageId);
    if (options.out) {
      await writeFile(options.out, result.raw);
      console.log(JSON.stringify({ messageId, source: result.source, bytes: result.raw.length, out: options.out, truncated: result.truncated }, null, 2));
    } else {
      process.stdout.write(result.raw);
    }
  });

program
  .command("headers <messageId>")
  .description("Print a message's parsed headers from the mirror (read-only, JSON output)")
  .option("--basic", "Only the basic threading headers (Message-ID/In-Reply-To/References/…)")
  .action(async (messageId: string, options) => {
    const result = await getMessageHeaders(pool, config, messageId, { basic: Boolean(options.basic) });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("clean-body <messageId>")
  .description("Print a deterministically cleaned message body (signature + quoted tail stripped)")
  .option("--include-quoted", "Keep the quoted reply tail + signature")
  .option("--max-chars <n>", "Clamp the cleaned body to n characters")
  .action(async (messageId: string, options) => {
    // A non-numeric `--max-chars abc` yields NaN, which would silently disable
    // truncation; fall back to the default (undefined) on anything non-finite.
    const maxCharsParsed = options.maxChars === undefined ? undefined : Number(options.maxChars);
    const result = await cleanMessageBody(pool, config, messageId, {
      includeQuoted: Boolean(options.includeQuoted),
      maxChars: Number.isFinite(maxCharsParsed) ? maxCharsParsed : undefined
    });
    console.log(JSON.stringify(result, null, 2));
  });

try {
  await program.parseAsync();
} finally {
  await closePool();
}
