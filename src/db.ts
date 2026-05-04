import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AppConfig } from "./config.js";
import { getConfig } from "./config.js";

const { Pool } = pg;

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

let cachedPool: PgPool | null = null;

export function assertSessionConnectionUrl(databaseUrl: string): void {
  const lowered = databaseUrl.toLowerCase();
  const url = new URL(databaseUrl);
  const host = url.hostname.toLowerCase();
  const port = url.port;

  if (
    lowered.includes("pgbouncer") ||
    lowered.includes("pooler") ||
    host.includes("pooler.supabase") ||
    port === "6543"
  ) {
    throw new Error(
      "DATABASE_URL appears to use a transaction pooler. IMAP sync uses advisory locks and requires a direct or session-affine Postgres connection."
    );
  }
}

export function createPool(config: Pick<AppConfig, "DATABASE_URL"> = getConfig()): PgPool {
  assertSessionConnectionUrl(config.DATABASE_URL);
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
}

export function getPool(): PgPool {
  cachedPool ??= createPool();
  return cachedPool;
}

export async function closePool(): Promise<void> {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
  }
}

export async function readInitialMigration(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationPath = resolve(here, "../supabase/migrations/0001_imap_mirror.sql");
  return readFile(migrationPath, "utf8");
}

export async function applyInitialMigration(pool: PgPool = getPool()): Promise<void> {
  const sql = await readInitialMigration();
  await pool.query(sql);
}
