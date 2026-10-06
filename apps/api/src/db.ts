import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AppConfig } from "./config.js";
import { getConfig } from "./config.js";
import { z } from "zod";
import { PUBLIC_MIGRATION_ID, publicMigrationSequence } from "./migration-id.js";

const { Pool } = pg;

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

/**
 * The manifest contract the schema gate relies on: every id is a public
 * migration id, ids strictly ascend, files are names, and `schemaVersion` is
 * the last id. Hosts read `schemaVersion` as the required version, so it
 * stays a field.
 */
export const publicMigrationManifestSchema = z.object({
  schemaVersion: z.string().min(1),
  migrations: z.array(z.object({
    id: z.string().regex(PUBLIC_MIGRATION_ID, "not a public migration id"),
    file: z.string().min(1).refine((file) => !file.includes("/") && !file.includes("\\"), "file must be a name")
  })).min(1)
}).superRefine((manifest, context) => {
  let previous = -1;
  for (const migration of manifest.migrations) {
    const sequence = publicMigrationSequence(migration.id)!;
    if (sequence <= previous) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `out of order at ${migration.id}` });
    }
    previous = sequence;
  }
  const last = manifest.migrations[manifest.migrations.length - 1]!.id;
  if (manifest.schemaVersion !== last) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `schemaVersion ${manifest.schemaVersion} is not its last migration ${last}`
    });
  }
});

export type PublicMigrationManifest = z.infer<typeof publicMigrationManifestSchema>;

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

let manifestPromise: Promise<PublicMigrationManifest> | null = null;

/**
 * The manifest ships inside the image and does not change while the process
 * runs, so it is read and validated once. A failed read is not kept: the next
 * call reads again.
 */
export function readPublicMigrationManifest(): Promise<PublicMigrationManifest> {
  manifestPromise ??= loadPublicMigrationManifest().catch((error: unknown) => {
    manifestPromise = null;
    throw error;
  });
  return manifestPromise;
}

async function loadPublicMigrationManifest(): Promise<PublicMigrationManifest> {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = resolve(here, "../supabase/migrations/public/manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  return assertPublicMigrationManifest(JSON.parse(raw));
}

export function assertPublicMigrationManifest(parsed: unknown): PublicMigrationManifest {
  const result = publicMigrationManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid public migration manifest: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return result.data;
}

export async function getRequiredPublicSchemaVersion(): Promise<string> {
  const manifest = await readPublicMigrationManifest();
  return manifest.schemaVersion;
}

/** Every public migration in manifest order, with its id. */
export async function readPublicMigrationFiles(): Promise<Array<{ id: string; sql: string }>> {
  const here = dirname(fileURLToPath(import.meta.url));
  const publicMigrationDir = resolve(here, "../supabase/migrations/public");
  const manifest = await readPublicMigrationManifest();
  return await Promise.all(manifest.migrations.map(async (migration) => ({
    id: migration.id,
    sql: await readFile(resolve(publicMigrationDir, migration.file), "utf8")
  })));
}

export async function readPublicMigrations(): Promise<string> {
  return (await readPublicMigrationFiles()).map((migration) => migration.sql).join("\n\n");
}

export async function readInitialMigration(): Promise<string> {
  return readPublicMigrations();
}

/**
 * Records each applied public migration, outside the API-exposed schemas, so a
 * migration runs once. A database migrated before this record existed applies
 * every file once more (each is idempotent) and records them all.
 */
export const PUBLIC_MIGRATION_RECORD_SQL = `
  CREATE SCHEMA IF NOT EXISTS supamail_meta;
  REVOKE ALL ON SCHEMA supamail_meta FROM PUBLIC;
  CREATE TABLE IF NOT EXISTS supamail_meta.public_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`;

export async function applyPublicMigrations(pool: PgPool = getPool()): Promise<void> {
  const migrations = await readPublicMigrationFiles();
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock(hashtext('supamail.public_migrations'))");
    await client.query(PUBLIC_MIGRATION_RECORD_SQL);
    const applied = new Set((await client.query<{ id: string }>(
      "SELECT id FROM supamail_meta.public_migrations"
    )).rows.map((row) => row.id));
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      // The migration and its record commit together or not at all.
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO supamail_meta.public_migrations (id) VALUES ($1)", [migration.id]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('supamail.public_migrations'))").catch(() => undefined);
    client.release();
  }
}

export async function applyInitialMigration(pool: PgPool = getPool()): Promise<void> {
  return applyPublicMigrations(pool);
}
