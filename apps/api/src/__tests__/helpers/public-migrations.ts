import { readPublicMigrationFiles, type PgPool } from "../../db.js";

/**
 * Make the database look migrated only up to the migration before `id`: forget
 * its record and every later one, so the next migrate applies them again.
 */
export async function forgetPublicMigrationsFrom(pool: PgPool, id: string): Promise<void> {
  const ids = (await readPublicMigrationFiles()).map((migration) => migration.id);
  const from = ids.indexOf(id);
  if (from < 0) throw new Error(`Unknown public migration ${id}`);
  await pool.query("DELETE FROM supamail_meta.public_migrations WHERE id = ANY($1::text[])", [ids.slice(from)]);
}
