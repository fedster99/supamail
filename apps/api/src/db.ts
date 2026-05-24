import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AppConfig } from "./config.js";
import { getConfig } from "./config.js";

const { Pool } = pg;

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

export interface PublicMigrationManifest {
  schemaVersion: string;
  migrations: Array<{
    id: string;
    file: string;
  }>;
}

let cachedPool: PgPool | null = null;

export function assertSessionConnectionUrl(databaseUrl: string): void {
  const lowered = databaseUrl.toLowerCase();
  const url = new URL(databaseUrl);
  const host = url.hostname.toLowerCase();
  const port = url.port;
  const isSupabaseSessionPooler = host.endsWith(".pooler.supabase.com") && port === "5432";

  if (
    lowered.includes("pgbouncer") ||
    (lowered.includes("pooler") && !isSupabaseSessionPooler) ||
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

export async function readPublicMigrationManifest(): Promise<PublicMigrationManifest> {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = resolve(here, "../supabase/migrations/public/manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as PublicMigrationManifest;

  if (!parsed.schemaVersion || !Array.isArray(parsed.migrations) || parsed.migrations.length === 0) {
    throw new Error("Invalid public migration manifest");
  }

  for (const migration of parsed.migrations) {
    if (!migration.id || !migration.file || migration.file.includes("/") || migration.file.includes("\\")) {
      throw new Error(`Invalid public migration manifest entry: ${JSON.stringify(migration)}`);
    }
  }

  return parsed;
}

export async function getRequiredPublicSchemaVersion(): Promise<string> {
  const manifest = await readPublicMigrationManifest();
  return manifest.schemaVersion;
}

export async function readPublicMigrations(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const publicMigrationDir = resolve(here, "../supabase/migrations/public");
  const manifest = await readPublicMigrationManifest();
  const sql = await Promise.all(
    manifest.migrations.map(async (migration) => readFile(resolve(publicMigrationDir, migration.file), "utf8"))
  );
  return sql.join("\n\n");
}

export async function readInitialMigration(): Promise<string> {
  return readPublicMigrations();
}

export async function applyPublicMigrations(pool: PgPool = getPool()): Promise<void> {
  const sql = await readPublicMigrations();
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock(hashtext('supamail.public_migrations'))");
    await client.query(sql);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('supamail.public_migrations'))").catch(() => undefined);
    client.release();
  }
}

export async function applyInitialMigration(pool: PgPool = getPool()): Promise<void> {
  return applyPublicMigrations(pool);
}
