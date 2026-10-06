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

  it("applies every file once more on a database migrated before the record existed", async () => {
    await getPool().query("DROP SCHEMA supamail_meta CASCADE");
    await applyPublicMigrations(getPool());
    const migrations = await readPublicMigrationFiles();
    expect(await recorded()).toEqual(migrations.map((migration) => migration.id).sort());
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
