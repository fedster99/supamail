import "dotenv/config";
import { z } from "zod";
import { MAX_SYNC_BATCH_SIZE } from "./sync-limits.js";
import type { BodyFetchPolicy, BodyStorageMode } from "./types.js";

export { MAX_SYNC_BATCH_SIZE } from "./sync-limits.js";

const optionalHourSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().min(0).max(23).optional()
);

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // Max connections in the pg pool. Defaults to 10 (the prior hardcoded value). Raise
  // it when one process drives many accounts/folders concurrently against a Postgres
  // that can afford the connections; keep it modest against connection-capped servers.
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  IMAP_ENCRYPTION_KEY: z.string().min(16),
  API_TOKEN: z.string().optional(),
  ADMIN_TOKEN: z.string().optional(),
  IMAP_ALLOW_PRIVATE_HOSTS: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => v === true || v === "true"),
  PORT: z.coerce.number().int().positive().default(3000),
  SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SENT_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  WINDOW_DAYS: z.coerce.number().int().positive().default(90),
  BODY_FETCH_POLICY: z
    .enum(["immediate", "lazy", "priority_then_backfill"])
    .default("priority_then_backfill"),
  // raw_mime keeps the original RFC822/MIME blob in imap_message_bodies.raw_mime.
  // parsed_only fetches and parses bodies normally but stores NULL raw_mime, for
  // deployments where raw blob retention dominates database size.
  BODY_STORAGE_MODE: z.enum(["raw_mime", "parsed_only"]).default("raw_mime"),
  BODY_RAW_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  // Initial projections have no baseline to compare against. Deployments that
  // consume conversations immediately may opt into the same atomic readiness
  // checks as explicit activation; upgrades and rebuilds remain review-gated.
  THREADING_AUTO_ACTIVATE_INITIAL: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .default(false)
    .transform((value) => value === true || value === "true"),
  BODY_BACKFILL_BATCH_SIZE: z.coerce.number().int().positive().max(MAX_SYNC_BATCH_SIZE).default(25),
  MAX_BODY_BATCHES_PER_TICK: z.coerce.number().int().positive().default(4),
  INITIAL_SYNC_BATCH_SIZE: z.coerce.number().int().positive().max(MAX_SYNC_BATCH_SIZE).default(50),
  INITIAL_SYNC_BATCH_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60_000),
  INCREMENTAL_SYNC_BATCH_SIZE: z.coerce.number().int().positive().max(MAX_SYNC_BATCH_SIZE).default(50),
  INCREMENTAL_TOTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60_000),
  FOLDER_DISCOVERY_INTERVAL_MS: z.coerce.number().int().positive().default(15 * 60_000),
  FLAG_DIFF_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  FLAG_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(10 * 60_000),
  PRIORITY_FLAG_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(2 * 60_000),
  RR_FLAG_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(6 * 60 * 60_000),
  MAX_FLAG_SCANS_PER_CYCLE: z.coerce.number().int().positive().default(2),
  FLAG_SCAN_TOTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(2 * 60_000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(6 * 60 * 60_000),
  MAX_RECONCILES_PER_CYCLE: z.coerce.number().int().positive().default(1),
  RECONCILE_TOTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60_000),
  CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  IMAP_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // IDLE is intentionally renewed before the RFC 2177 29-minute guidance.
  // The socket timeout must remain longer than one renewal interval so a quiet
  // mailbox does not look like a dead connection.
  IMAP_IDLE_MAX_TIME_MS: z.coerce.number().int().positive().default(25 * 60_000),
  IMAP_IDLE_SOCKET_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60_000),
  SMTP_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60_000),
  IMAP_MAX_COMMANDS_PER_MINUTE: z.coerce.number().int().positive().default(200),
  MAX_LOCK_HOLD_MS: z.coerce.number().int().positive().default(10 * 60_000),
  STALE_HEARTBEAT_MS: z.coerce.number().int().positive().default(5 * 60_000),
  MAX_UIDVALIDITY_RESETS_24H: z.coerce.number().int().positive().default(2),
  FOLDER_MISSING_GRACE_MS: z.coerce.number().int().positive().default(7 * 24 * 60 * 60_000),
  STUCK_DEGRADED_BROKEN_THRESHOLD_MS: z.coerce.number().int().positive().default(24 * 60 * 60_000),
  STUCK_DEGRADED_TERMINAL_THRESHOLD_MS: z.coerce.number().int().positive().default(7 * 24 * 60 * 60_000),
  STUCK_DEGRADED_RETRY_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60_000),
  FOLDER_COUNT_WARN_THRESHOLD: z.coerce.number().int().positive().default(50),
  FOLDER_COUNT_ENFORCE_THRESHOLD: z.coerce.number().int().positive().default(200),
  PRIORITY_CUTOFF: z.coerce.number().int().positive().default(10),
  MAX_PRIORITY_FOLDERS_PER_CYCLE: z.coerce.number().int().positive().default(10),
  MAX_RR_FOLDERS_PER_CYCLE: z.coerce.number().int().positive().default(5),
  SYNC_MAX_ACCOUNTS: z.coerce.number().int().positive().default(20),
  PRIORITY_LAG_HEALTHY_THRESHOLD_MS: z.coerce.number().int().positive().default(120_000),
  OVERALL_LAG_HEALTHY_THRESHOLD_MS: z.coerce.number().int().positive().default(15 * 60_000),
  PRIORITY_RECONCILE_HEALTHY_MAX_AGE_MS: z.coerce.number().int().positive().default(24 * 60 * 60_000),
  OVERALL_RECONCILE_HEALTHY_MAX_AGE_MS: z.coerce.number().int().positive().default(7 * 24 * 60 * 60_000),
  EXPIRE_AFTER_DAYS: z.coerce.number().int().positive().default(180),
  SYNC_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  RECENT_UIDVALIDITY_RESET_DEGRADED_MS: z.coerce.number().int().positive().default(60 * 60_000),
  BACKFILL_WINDOW_START_HOUR: optionalHourSchema,
  BACKFILL_WINDOW_END_HOUR: optionalHourSchema,
  BACKFILL_WINDOW_TIMEZONE: z.string().default("UTC").refine(isValidTimeZone, {
    message: "BACKFILL_WINDOW_TIMEZONE must be a valid IANA time zone"
  })
}).superRefine((env, ctx) => {
  if (env.IMAP_IDLE_SOCKET_TIMEOUT_MS <= env.IMAP_IDLE_MAX_TIME_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "IMAP_IDLE_SOCKET_TIMEOUT_MS must exceed IMAP_IDLE_MAX_TIME_MS",
      path: ["IMAP_IDLE_SOCKET_TIMEOUT_MS"]
    });
  }

  const hasStart = env.BACKFILL_WINDOW_START_HOUR !== undefined;
  const hasEnd = env.BACKFILL_WINDOW_END_HOUR !== undefined;
  if (hasStart !== hasEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "BACKFILL_WINDOW_START_HOUR and BACKFILL_WINDOW_END_HOUR must be set together",
      path: hasStart ? ["BACKFILL_WINDOW_END_HOUR"] : ["BACKFILL_WINDOW_START_HOUR"]
    });
  }

  if (
    hasStart &&
    hasEnd &&
    env.BACKFILL_WINDOW_START_HOUR === env.BACKFILL_WINDOW_END_HOUR
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "BACKFILL_WINDOW_START_HOUR and BACKFILL_WINDOW_END_HOUR must differ; unset both to disable the gate",
      path: ["BACKFILL_WINDOW_END_HOUR"]
    });
  }
});

export type AppConfig = z.infer<typeof envSchema> & {
  BODY_FETCH_POLICY: BodyFetchPolicy;
  BODY_STORAGE_MODE: BodyStorageMode;
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

export function isWithinBackfillWindow(
  config: Pick<AppConfig, "BACKFILL_WINDOW_START_HOUR" | "BACKFILL_WINDOW_END_HOUR" | "BACKFILL_WINDOW_TIMEZONE">,
  now = new Date()
): boolean {
  const start = config.BACKFILL_WINDOW_START_HOUR;
  const end = config.BACKFILL_WINDOW_END_HOUR;
  if (start === undefined && end === undefined) return true;
  if (start === undefined || end === undefined) return false;

  const hourPart = new Intl.DateTimeFormat("en-US", {
    timeZone: config.BACKFILL_WINDOW_TIMEZONE,
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23"
  }).formatToParts(now).find((part) => part.type === "hour");
  const hour = Number(hourPart?.value);

  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}
