import { afterAll, describe, expect, it } from "vitest";
import {
  applyPublicMigrations,
  closePool,
  getPool,
  readPublicMigrationFiles,
  type PgPool
} from "../db.js";

const LIVE_DB_AVAILABLE = process.env.LIVE_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const liveDb = LIVE_DB_AVAILABLE ? describe : describe.skip;

/** A pool whose clients report every SQL text they run. */
function recordingPool(pool: PgPool, ran: string[]): PgPool {
  return {
    connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client);
      return Object.assign(client, {
        query: (text: unknown, ...rest: unknown[]) => {
          if (typeof text === "string") ran.push(text);
          return (query as (...args: unknown[]) => unknown)(text, ...rest);
        }
      });
    }
  } as unknown as PgPool;
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

    const ran: string[] = [];
    await applyPublicMigrations(recordingPool(getPool(), ran));
    const migrationSql = new Set(migrations.map((migration) => migration.sql));
    expect(ran.filter((text) => migrationSql.has(text))).toEqual([]);
  });

  it("applies every file once more on a database migrated before the record existed", async () => {
    await getPool().query("DROP SCHEMA supamail_meta CASCADE");
    await applyPublicMigrations(getPool());
    const migrations = await readPublicMigrationFiles();
    expect(await recorded()).toEqual(migrations.map((migration) => migration.id).sort());
  });

  it("applies only migrations missing from the record, in manifest order", async () => {
    const migrations = await readPublicMigrationFiles();
    const last = migrations[migrations.length - 1];
    await getPool().query("DELETE FROM supamail_meta.public_migrations WHERE id = $1", [last.id]);
    const ran: string[] = [];
    await applyPublicMigrations(recordingPool(getPool(), ran));
    const migrationSql = new Set(migrations.map((migration) => migration.sql));
    expect(ran.filter((text) => migrationSql.has(text))).toEqual([last.sql]);
    expect(await recorded()).toContain(last.id);
  });
});
