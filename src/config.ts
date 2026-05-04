import "dotenv/config";
import { z } from "zod";
import type { BodyFetchPolicy } from "./types.js";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  IMAP_ENCRYPTION_KEY: z.string().min(16),
  API_TOKEN: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  WINDOW_DAYS: z.coerce.number().int().positive().default(90),
  BODY_FETCH_POLICY: z
    .enum(["immediate", "lazy", "priority_then_backfill"])
    .default("priority_then_backfill"),
  BODY_RAW_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  BODY_BACKFILL_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  INITIAL_SYNC_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  INCREMENTAL_SYNC_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  FOLDER_DISCOVERY_INTERVAL_MS: z.coerce.number().int().positive().default(15 * 60_000),
  FLAG_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(10 * 60_000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(6 * 60 * 60_000),
  CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  IMAP_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  IMAP_MAX_COMMANDS_PER_MINUTE: z.coerce.number().int().positive().default(200),
  MAX_LOCK_HOLD_MS: z.coerce.number().int().positive().default(10 * 60_000),
  MAX_UIDVALIDITY_RESETS_24H: z.coerce.number().int().positive().default(2),
  PRIORITY_CUTOFF: z.coerce.number().int().positive().default(10),
  EXPIRE_AFTER_DAYS: z.coerce.number().int().positive().default(180)
});

export type AppConfig = z.infer<typeof envSchema> & {
  BODY_FETCH_POLICY: BodyFetchPolicy;
};

let cachedConfig: AppConfig | null = null;

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  cachedConfig ??= envSchema.parse(env);
  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = null;
}

export function getWindowCutoff(config: Pick<AppConfig, "WINDOW_DAYS">): Date {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.WINDOW_DAYS);
  return cutoff;
}
