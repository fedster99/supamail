#!/usr/bin/env node
import { Command } from "commander";
import { getConfig } from "./config.js";
import { applyInitialMigration, closePool, getPool } from "./db.js";
import { MirrorRepository } from "./repository.js";
import { MirrorEngine } from "./sync-engine.js";

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
  .description("Apply the initial Supabase/Postgres migration")
  .action(async () => {
    await applyInitialMigration(pool);
    console.log("Migration applied");
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

try {
  await program.parseAsync();
} finally {
  await closePool();
}
