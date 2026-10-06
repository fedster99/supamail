import { afterAll, describe, expect, it } from "vitest";
import {
  PublicMigrationError,
  applyPublicMigrations,
  closePool,
  createPool,
  getPool,
  readPublicMigrationFiles,
  type PgPool
} from "../db.js";
import { getConfig } from "../config.js";
import { forgetPublicMigrationsFrom } from "./helpers/public-migrations.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

/** Run migrate on its own pool and return every SQL text it sent. */
async function migrateRecording(): Promise<string[]> {
  const ran: string[] = [];
  const pool = createPool(getConfig());
  const recording = {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, key, receiver) {
          if (key !== "query") return Reflect.get(target, key, receiver);
          return (text: unknown, ...rest: unknown[]) => {
            if (typeof text === "string") ran.push(text);
            return (target.query as (...args: unknown[]) => unknown).call(target, text, ...rest);
          };
        }
      });
    }
  } as unknown as PgPool;
  try {
    await applyPublicMigrations(recording);
  } finally {
    await pool.end();
  }
  return ran;
}

liveDb("public migrations run once", () => {
  afterAll(async () => {
    await closePool();
  });

  async function recorded(): Promise<string[]> {
    return (await getPool().query<{ id: string }>(
      "SELECT id FROM supamail_meta.public_migrations ORDER BY id"
    )).rows.map((row) => row.id);
  }

  it("records every migration and applies none again", async () => {
    const migrations = await readPublicMigrationFiles();
    await applyPublicMigrations(getPool());
    expect(await recorded()).toEqual(migrations.map((migration) => migration.id).sort());

    const migrationSql = new Set(migrations.map((migration) => migration.sql));
    expect((await migrateRecording()).filter((text) => migrationSql.has(text))).toEqual([]);
  });

  it("upgrades a database the old runner left at 0029, repairs included", async () => {
    // The old runner re-applied every file. Build a database it left at 0029,
    // with the state the date-filtered engine left, so the new runner also runs
    // 0030's one-time repairs on its way past 0032.
    const migrations = await readPublicMigrationFiles();
    const legacyCount = migrations.findIndex((migration) => migration.id === "0029_active_assignments_view_no_barrier") + 1;
    const database = `supamail_legacy_${process.pid}`;
    await getPool().query(`DROP DATABASE IF EXISTS ${database}`);
    await getPool().query(`CREATE DATABASE ${database}`);
    const url = new URL(getConfig().DATABASE_URL);
    url.pathname = `/${database}`;
    const legacy = createPool({ DATABASE_URL: url.toString() });
    try {
      for (let run = 0; run < 2; run += 1) {
        await legacy.query(migrations.slice(0, legacyCount).map((migration) => migration.sql).join("\n\n"));
      }
      const account = (await legacy.query<{ id: string }>(
        `INSERT INTO public.imap_accounts (email_address, host, port, username, encrypted_password, historical_backfill_mode)
         VALUES ('legacy@example.test', 'imap.example.test', 993, 'legacy', '\\x00'::bytea, 'metadata_only')
         RETURNING id`
      )).rows[0].id;
      await legacy.query(
        `INSERT INTO public.imap_folders (account_id, path, tracked, status, uidvalidity, initial_sync_complete,
           uid_next, last_uid, historical_target_count, backfill_in_progress, last_archive_refresh_at)
         VALUES ($1, 'INBOX', true, 'ACTIVE', 7, true, 50, 3, 10, false, now())`,
        [account]
      );
      await legacy.query(
        `INSERT INTO public.imap_messages (account_id, folder_path, uidvalidity, uid, internal_date,
           deleted_in_provider, provider_deleted_at, deleted_reason)
         VALUES ($1, 'INBOX', 7, 1, now() - interval '200 days', true, now(), 'MOVED_OUT')`,
        [account]
      );
      await applyPublicMigrations(legacy);
      const repaired = (await legacy.query<{ last_uid: string; backfill_in_progress: boolean; historical_target_count: number }>(
        "SELECT last_uid::text, backfill_in_progress, historical_target_count FROM public.imap_folders WHERE account_id = $1",
        [account]
      )).rows[0];
      // The head moves to UIDNEXT and history is re-taken once, keeping its progress.
      expect(repaired).toEqual({ last_uid: "49", backfill_in_progress: true, historical_target_count: 10 });
      const reason = await legacy.query<{ deleted_reason: string }>(
        "SELECT deleted_reason FROM public.imap_messages WHERE account_id = $1",
        [account]
      );
      expect(reason.rows[0].deleted_reason).toBe("RECONCILE_MISSING");
      const ids = (await legacy.query<{ id: string }>(
        "SELECT id FROM supamail_meta.public_migrations ORDER BY id"
      )).rows.map((row) => row.id);
      expect(ids).toEqual(migrations.map((migration) => migration.id).sort());
      const column = await legacy.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'imap_messages' AND column_name = 'window_status'"
      );
      expect(column.rows).toEqual([]);
    } finally {
      await legacy.end();
      await getPool().query(`DROP DATABASE IF EXISTS ${database}`);
    }
  });

  it("applies only migrations missing from the record, in manifest order", async () => {
    const migrations = await readPublicMigrationFiles();
    const tail = migrations.slice(-2);
    await forgetPublicMigrationsFrom(getPool(), tail[0].id);
    const migrationSql = new Set(migrations.map((migration) => migration.sql));
    expect((await migrateRecording()).filter((text) => migrationSql.has(text)))
      .toEqual(tail.map((migration) => migration.sql));
    expect(await recorded()).toEqual(migrations.map((migration) => migration.id).sort());
  });

  it("refuses a migration listed before one that already ran", async () => {
    const migrations = await readPublicMigrationFiles();
    const middle = migrations[migrations.length - 2];
    await getPool().query("DELETE FROM supamail_meta.public_migrations WHERE id = $1", [middle.id]);
    try {
      await expect(applyPublicMigrations(getPool())).rejects.toBeInstanceOf(PublicMigrationError);
    } finally {
      await getPool().query("INSERT INTO supamail_meta.public_migrations (id) VALUES ($1)", [middle.id]);
    }
  });

  it("keeps the active-assignments view's columns equal to its table's", async () => {
    const columns = async (relation: string) => (await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [relation]
    )).rows.map((row) => row.column_name);
    expect(await columns("imap_thread_active_assignments")).toEqual(await columns("imap_thread_assignments"));
  });
});
