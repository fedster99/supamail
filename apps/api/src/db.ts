import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AppConfig } from "./config.js";
import { getConfig } from "./config.js";
import { publicMigrationSequence } from "./migration-id.js";

const { Pool } = pg;

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

export interface PublicMigrationManifest {
  /** The last migration's id. Hosts read it as the required version, so it stays a field. */
  schemaVersion: string;
  migrations: Array<{
    id: string;
    file: string;
  }>;
}

let cachedPool: PgPool | null = null;

/**
 * Server-side TCP liveness for every pooled session. An abruptly vanished worker
 * VM leaves its sessions, and their account locks, alive on the server until TCP
 * notices (about 39 minutes with common server defaults). These probes release
 * them in about a minute, while a stalled but alive worker's kernel keeps
 * answering, so it keeps its locks. The user timeout covers unacknowledged data,
 * which suspends keepalive probing. They are no-ops on Unix sockets, where the
 * kernel reports process exit.
 */
export const SERVER_TCP_LIVENESS_SQL =
  "SET tcp_keepalives_idle = 30; SET tcp_keepalives_interval = 10; " +
  "SET tcp_keepalives_count = 3; SET tcp_user_timeout = 60000";

/**
 * Through a session pooler, the pooler owns the server sessions: server-side
 * probes reach it rather than the worker, so they cannot detect a vanished
 * worker. Stale-heartbeat lock takeover remains the recovery path there.
 */
export function isSupabaseSessionPoolerUrl(databaseUrl: string | undefined): boolean {
  if (!databaseUrl || !URL.canParse(databaseUrl)) return false;
  const url = new URL(databaseUrl);
  return url.hostname.toLowerCase().endsWith(".pooler.supabase.com") && url.port === "5432";
}

export function assertSessionConnectionUrl(databaseUrl: string): void {
  const lowered = databaseUrl.toLowerCase();
  const url = new URL(databaseUrl);
  const port = url.port;
  const isSupabaseSessionPooler = isSupabaseSessionPoolerUrl(databaseUrl);

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

export function createPool(
  config: Pick<AppConfig, "DATABASE_URL"> & Partial<Pick<AppConfig, "DATABASE_POOL_MAX">> = getConfig()
): PgPool {
  assertSessionConnectionUrl(config.DATABASE_URL);
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    // Backward-compatible: callers passing only { DATABASE_URL } still get the old max of 10.
    max: config.DATABASE_POOL_MAX ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  if (!isSupabaseSessionPoolerUrl(config.DATABASE_URL)) {
    // Queued before the caller's first query. A proxy that refuses the SET only
    // loses faster release of a vanished worker's locks, so log and continue.
    pool.on("connect", (client) => {
      client.query(SERVER_TCP_LIVENESS_SQL).catch((error: Error) => {
        console.error(JSON.stringify({
          event: "database.pool.tcp_liveness_setup_error",
          error: { message: error.message, code: (error as NodeJS.ErrnoException).code }
        }));
      });
    });
  }
  // node-postgres emits errors from idle clients on the pool itself. Without a
  // listener, EventEmitter promotes a recoverable connection loss (database
  // restart, failover, or administrator termination) to an uncaught exception
  // and takes down the whole API/worker process. The pool has already removed
  // the failed client; log it and let the next checkout establish a new one.
  pool.on("error", (error) => {
    console.error(JSON.stringify({
      event: "database.pool.idle_client_error",
      error: {
        message: error.message,
        code: (error as NodeJS.ErrnoException).code,
        stack: error.stack
      }
    }));
  });
  return pool;
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
  return assertPublicMigrationManifest(JSON.parse(raw));
}

/**
 * The manifest contract the schema gate relies on: every id is a public
 * migration id, ids strictly ascend, and the schema version is the last id.
 */
export function assertPublicMigrationManifest(parsed: unknown): PublicMigrationManifest {
  const manifest = parsed as PublicMigrationManifest;
  if (!manifest?.schemaVersion || !Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
    throw new Error("Invalid public migration manifest");
  }
  let previous = -1;
  for (const migration of manifest.migrations) {
    const sequence = typeof migration?.id === "string" ? publicMigrationSequence(migration.id) : null;
    if (
      sequence === null
      || typeof migration.file !== "string"
      || migration.file === ""
      || migration.file.includes("/")
      || migration.file.includes("\\")
    ) {
      throw new Error(`Invalid public migration manifest entry: ${JSON.stringify(migration)}`);
    }
    if (sequence <= previous) {
      throw new Error(`Public migration manifest is out of order at ${migration.id}`);
    }
    previous = sequence;
  }
  const last = manifest.migrations[manifest.migrations.length - 1]!.id;
  if (manifest.schemaVersion !== last) {
    throw new Error(`Public migration manifest version ${manifest.schemaVersion} is not its last migration ${last}`);
  }
  return manifest;
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
