import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPublicMigrations,
  getRequiredPublicSchemaVersion,
  readPublicMigrationManifest,
  readPublicMigrations
} from "../db.js";

const publicMigrationPath = resolve(process.cwd(), "supabase/migrations/public/0001_imap_mirror.sql");

describe("initial schema", () => {
  it("contains the neutral mirror tables and raw body storage", async () => {
    const sql = await readFile(publicMigrationPath, "utf8");

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
    const sql = await readFile(publicMigrationPath, "utf8");

    for (const trigger of [
      "imap_accounts_set_updated_at",
      "imap_folders_set_updated_at",
      "imap_messages_set_updated_at",
      "imap_message_bodies_set_updated_at"
    ]) {
      expect(sql).toContain(`DROP TRIGGER IF EXISTS ${trigger}`);
    }

    expect(sql.match(/SET search_path = ''/g)).toHaveLength(1);
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.imap_encrypt_password");
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.imap_decrypt_password");
    expect(sql).not.toContain("pgp_sym_encrypt");
    expect(sql).not.toContain("pgp_sym_decrypt");
  });

  it("locks down Supabase Data API exposure by default", async () => {
    const sql = await readFile(publicMigrationPath, "utf8");

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

    expect(sql).not.toContain("REVOKE EXECUTE ON FUNCTION public.imap_encrypt_password");
    expect(sql).not.toContain("REVOKE EXECUTE ON FUNCTION public.imap_decrypt_password");
  });

  it("deduplicates attachments by stable MIME part number", async () => {
    const sql = await readFile(publicMigrationPath, "utf8");

    expect(sql).toContain("UNIQUE (message_id, part_number)");
    expect(sql).not.toContain("UNIQUE (message_id, part_number, content_id, filename)");
  });

  it("serializes programmatic public migration calls with an advisory lock", async () => {
    expect(applyPublicMigrations.toString()).toContain("pg_advisory_lock(hashtext('supamail.public_migrations'))");
  });

  it("exposes an ordered public migration manifest for hosted deploy gates", async () => {
    const manifest = await readPublicMigrationManifest();
    const version = await getRequiredPublicSchemaVersion();
    const sql = await readPublicMigrations();

    expect(version).toBe("0001_imap_mirror");
    expect(manifest).toEqual({
      schemaVersion: "0001_imap_mirror",
      migrations: [{ id: "0001_imap_mirror", file: "0001_imap_mirror.sql" }]
    });
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.imap_accounts");
  });

  it("keeps control-plane migrations out of the public core package path", async () => {
    const packageJson = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as {
      files?: string[];
    };
    const loader = await readFile(resolve(process.cwd(), "src/db.ts"), "utf8");

    await expect(access(resolve(process.cwd(), "supabase/migrations/control-plane"))).rejects.toThrow();
    expect(packageJson.files).toContain("supabase/migrations/public");
    expect(packageJson.files).not.toContain("supabase/migrations");
    expect(loader).toContain("../supabase/migrations/public");
    expect(loader).not.toContain("control-plane");
  });
});
