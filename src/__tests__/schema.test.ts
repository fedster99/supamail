import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyInitialMigration } from "../db.js";

describe("initial schema", () => {
  it("contains the neutral mirror tables and raw body storage", async () => {
    const sql = await readFile(resolve(process.cwd(), "supabase/migrations/0001_imap_mirror.sql"), "utf8");

    for (const table of [
      "imap_accounts",
      "imap_folders",
      "imap_messages",
      "imap_message_bodies",
      "imap_attachments",
      "imap_sync_runs",
      "imap_sync_events"
    ]) {
      expect(sql).toContain(`public.${table}`);
    }

    expect(sql).toContain("raw_mime bytea NOT NULL");
    expect(sql).toContain("body_fetch_policy");
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA extensions");
    expect(sql).toContain("email_address extensions.citext NOT NULL UNIQUE");
  });

  it("keeps repeat local dry runs and Supabase advisors clean", async () => {
    const sql = await readFile(resolve(process.cwd(), "supabase/migrations/0001_imap_mirror.sql"), "utf8");

    for (const trigger of [
      "imap_accounts_set_updated_at",
      "imap_folders_set_updated_at",
      "imap_messages_set_updated_at",
      "imap_message_bodies_set_updated_at"
    ]) {
      expect(sql).toContain(`DROP TRIGGER IF EXISTS ${trigger}`);
    }

    expect(sql.match(/SET search_path = ''/g)).toHaveLength(3);
    expect(sql).toContain("extensions.pgp_sym_encrypt");
    expect(sql).toContain("extensions.pgp_sym_decrypt");
  });

  it("serializes programmatic migration calls with an advisory lock", async () => {
    expect(applyInitialMigration.toString()).toContain("pg_advisory_lock(hashtext('supamail.initial_migration'))");
  });
});
