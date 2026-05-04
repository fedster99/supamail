import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
  });
});
