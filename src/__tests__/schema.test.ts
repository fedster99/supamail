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
    expect(sql).toContain("email_address text NOT NULL");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS imap_accounts_email_address_lower_uidx");
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

    expect(sql.match(/SET search_path = ''/g)).toHaveLength(1);
    expect(sql.match(/SET search_path = extensions, public/g)).toHaveLength(2);
    expect(sql).toContain("pgp_sym_encrypt");
    expect(sql).toContain("pgp_sym_decrypt");
  });

  it("locks down Supabase Data API exposure by default", async () => {
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
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`REVOKE ALL ON TABLE public.${table} FROM anon`);
      expect(sql).toContain(`REVOKE ALL ON TABLE public.${table} FROM authenticated`);
    }

    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION public.imap_encrypt_password(text, text) FROM PUBLIC");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION public.imap_decrypt_password(bytea, text) FROM PUBLIC");
  });

  it("deduplicates attachments by stable MIME part number", async () => {
    const sql = await readFile(resolve(process.cwd(), "supabase/migrations/0001_imap_mirror.sql"), "utf8");

    expect(sql).toContain("UNIQUE (message_id, part_number)");
    expect(sql).not.toContain("UNIQUE (message_id, part_number, content_id, filename)");
  });

  it("serializes programmatic migration calls with an advisory lock", async () => {
    expect(applyInitialMigration.toString()).toContain("pg_advisory_lock(hashtext('supamail.initial_migration'))");
  });
});
