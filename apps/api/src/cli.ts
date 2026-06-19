#!/usr/bin/env node
import { Command } from "commander";
import { getConfig } from "./config.js";
import { applyPublicMigrations, closePool, getPool } from "./db.js";
import { MirrorRepository } from "./repository.js";
import { MirrorEngine } from "./sync-engine.js";
import { searchMessages } from "./search/index.js";
import type { SearchRequest, SearchSort } from "./search/index.js";
import type { WindowStatus } from "./types.js";

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
  .action(async (options) => {
    const account = await repository.createAccount({
      emailAddress: options.email,
      host: options.host,
      port: Number(options.port),
      secure: !options.insecure,
      username: options.username,
      password: options.password,
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

try {
  await program.parseAsync();
} finally {
  await closePool();
}
