import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeFlags } from "../repository.js";

describe("repository safety", () => {
  it("normalizes IMAP flags for stable diffing", () => {
    expect(normalizeFlags(["\\Seen", "\\Flagged", "\\seen", " "])).toEqual(["\\flagged", "\\seen"]);
  });

  it("keeps external account responses on the sanitized summary shape", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("const ACCOUNT_SUMMARY_COLUMNS");
    expect(source).toContain("Promise<AccountSummary>");
    expect(source).toContain("RETURNING ${ACCOUNT_SUMMARY_COLUMNS}");
    expect(source).toContain("SELECT ${ACCOUNT_SUMMARY_COLUMNS} FROM public.imap_accounts");
  });

  it("reclaims stale sync leases instead of bricking accounts", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("currently_syncing = false");
    expect(source).toContain("last_heartbeat_at <= now() - ($2::bigint * interval '1 millisecond')");
    expect(source).toContain("this.config.STALE_HEARTBEAT_MS");
  });

  it("does not mark incomplete initial sync as healthy", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("INITIAL_SYNC_IN_PROGRESS");
    expect(source).toContain("incomplete_count > 0 THEN 'INITIAL_SYNC'");
    expect(source).toContain("PRIORITY_RECONCILE_STALE");
    expect(source).toContain("OVERALL_RECONCILE_STALE");
    expect(source).toContain("PRIORITY_RECONCILE_HEALTHY_MAX_AGE_MS");
    expect(source).toContain("ELSE 'HEALTHY'");
    expect(source).not.toContain("CASE WHEN sync_state = 'INITIAL_SYNC' THEN 'HEALTHY' ELSE sync_state END");
  });

  it("sanitizes sync run errors before persistence", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("const sanitizedErrors = result.errors.map(sanitizeErrorReason)");
    expect(source).toContain("JSON.stringify({ errors: sanitizedErrors, hitLockBudget: result.hitLockBudget })");
  });

  it("stores NULL raw_mime when BODY_STORAGE_MODE is parsed_only", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain('this.config.BODY_STORAGE_MODE === "parsed_only" ? null : body.rawMime');
  });

  it("does not hold account locks with idle transactions", async () => {
    const source = await readFile(resolve(process.cwd(), "src/locks.ts"), "utf8");

    expect(source).toContain("pg_try_advisory_lock");
    expect(source).toContain("pg_advisory_unlock");
    expect(source).toContain("runLockSelfTest");
    expect(source).toContain("clearOrphanedLockForAccount");
    expect(source).toContain("pg_terminate_backend");
    expect(source).not.toContain("pg_try_advisory_xact_lock");
    expect(source).not.toContain('client.query("BEGIN")');
  });

  it("does not immediately untrack folders after one missing LIST pass", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("AND missing_since IS NOT NULL");
    expect(source).toContain("SET missing_since = now()");
  });

  it("enforces folder-count caps without hiding automatic recovery", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("FOLDER_COUNT_WARN_THRESHOLD");
    expect(source).toContain("FOLDER_COUNT_ENFORCE_THRESHOLD");
    expect(source).toContain("folder_count_cap_override");
    expect(source).toContain("folder_count_cap_exceeded");
    expect(source).toContain("MANY_FOLDERS_PERFORMANCE_NOTE");
    expect(source).toContain("TOO_MANY_FOLDERS_REQUIRES_MANUAL_CONFIG");
    expect(source).toContain("missing_since IS NULL");
  });

  it("does not schedule folders pending missing-mailbox verification", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("PENDING_VERIFICATION");
    expect(source).toContain("status NOT IN ('MISSING', 'PENDING_VERIFICATION')");
    expect(source).toContain("public.imap_folders.status IN ('MISSING', 'PENDING_VERIFICATION')");
    expect(source).toContain("markFolderPendingVerification");
    expect(source).toContain("next_folder_discovery_at = now()");
    expect(source).toContain("FOLDER_PENDING_VERIFICATION");
  });

  it("drops discovery-flagged missing folders from the sync + history working set", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");
    const collapsed = source.replace(/\s+/g, " ");

    // A folder discovery has stamped missing_since (deleted from the provider) must
    // leave every sync working set at once. Otherwise the sync lane keeps SELECTing
    // it, the provider returns a generic error (e.g. Rackspace "Command failed",
    // which is not a recognized missing-mailbox signal), the run fails, and
    // consecutive_failures climbs to BROKEN — one deleted folder bricking the
    // account. All four readers must carry the exclusion: getFoldersDueForSync
    // (priority + round-robin), getHistoryBacklog, and getBodyBacklog (the body lane
    // is the one un-try/caught reader, so a missed exclusion there bricks directly).
    const syncFilter = "AND missing_since IS NULL AND status NOT IN ('MISSING', 'PENDING_VERIFICATION')";
    const joinedFilter = "AND f.missing_since IS NULL AND f.status NOT IN ('MISSING', 'PENDING_VERIFICATION')";

    expect(collapsed.split(syncFilter).length - 1).toBe(2);
    expect(collapsed.split(joinedFilter).length - 1).toBe(2);
  });

  it("persists manual folder opt-ins across folder-count cap rediscovery", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("MANUAL_TRACK_OVERRIDE_NOTE");
    expect(source).toContain("manual_track_override");
    expect(source).toContain("trackFolder");
    expect(source).toContain("last_progress_note = $3");
    expect(source).toContain("!manuallyTracked");
  });

  it("updates only mutable account lane settings", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("updateAccountSettings");
    expect(source).toContain("historical_backfill_mode = COALESCE($2::text, historical_backfill_mode)");
    expect(source).toContain("archive_refresh_interval = COALESCE($3::text, archive_refresh_interval)");
    expect(source).toContain("archive_flag_sync = COALESCE($4::boolean, archive_flag_sync)");
    expect(source).toContain("max_backfill_rate = COALESCE($5::text, max_backfill_rate)");
    expect(source).not.toContain("live_window_days =");
  });

  it("rejects account settings patches that try to mutate live_window_days", async () => {
    const source = await readFile(resolve(process.cwd(), "src/api.ts"), "utf8");

    expect(source).toContain("live_window_days is immutable after account creation");
    expect(source).toContain("liveWindowDays");
    expect(source).toContain("live_window_days");
  });

  it("maintains progress counters at the write sites", async () => {
    const repository = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");
    const engine = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(repository).toContain("live_window_target_count = $4");
    expect(repository).toContain("headers_synced_count = headers_synced_count + 1");
    expect(repository).toContain("bodies_fetched_count = bodies_fetched_count + 1");
    expect(repository).toContain("FOR UPDATE");
    expect(repository).toContain("if (!message.body_fetched_at)");
    expect(repository).toContain("headers_synced_count = 0");
    expect(repository).toContain("bodies_fetched_count = 0");
    expect(repository).toContain("historical_target_count = NULL");
    expect(engine).toContain("setInitialSyncSnapshot(folder.id, targetMaxUid, oldestSynced, sortedTargets.length)");
  });

  it("persists resumable history-lane state and backlog reasons", async () => {
    const repository = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");
    const engine = await readFile(resolve(process.cwd(), "src/sync-engine.ts"), "utf8");

    expect(repository).toContain("getHistoryBacklog");
    expect(repository).toContain("history_backlog_reason");
    expect(repository).toContain("setHistoryBackfillSnapshot");
    expect(repository).toContain("advanceHistoryBackfillWatermark");
    expect(repository).toContain("markHistoryBackfillComplete");
    expect(repository).toContain("getHistoricalBodyBacklog");
    expect(repository).toContain("last_archive_refresh_at");
    expect(repository).toContain("preserveExistingFlags");
    expect(engine).toContain("runHistoryLane");
    expect(engine).toContain("historyBatchLimit");
    expect(engine).toContain("searchUidsBefore");
    expect(engine).toContain("historical_backfill_mode === \"off\"");
  });

  it("exposes account details through the progress view", async () => {
    const repository = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");
    const api = await readFile(resolve(process.cwd(), "src/api.ts"), "utf8");

    expect(repository).toContain("getAccountDetails");
    expect(repository).toContain("public.imap_account_progress");
    expect(repository).toContain("headers_pct");
    expect(api).toContain('app.get("/accounts/:id"');
    expect(api).toContain("getAccountDetails");
  });

  it("tombstones folder messages after the missing grace expires", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("deleted_reason = 'FOLDER_MISSING'");
    expect(source).toContain("\"FOLDER_MISSING\"");
    expect(source).toContain("FOLDER_MISSING_GRACE_EXCEEDED");
  });

  it("self-heals BROKEN accounts that have a scheduled retry, not the terminal ones", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    // getRunnableAccounts retries a BROKEN account once its backoff_until passes.
    // backoff_until IS NOT NULL is the "can recover on its own" marker; the terminal
    // paths (AUTH_ERROR, UIDVALIDITY-cap, STUCK_DEGRADED_TERMINAL) NULL it on purpose.
    expect(source).toContain("sync_state NOT IN ('PAUSED', 'BROKEN')");
    expect(source).toContain("sync_state = 'BROKEN' AND backoff_until IS NOT NULL");
    // Failure-threshold BROKEN must schedule its retry on the calm heal cadence ($8 =
    // STUCK_DEGRADED_RETRY_INTERVAL_MS), so it self-heals but is not hammered.
    expect(source).toMatch(/WHEN a\.consecutive_failures \+ 1 >= \$3 THEN now\(\) \+ \(\$8::bigint/);
    // AUTH_ERROR stays terminal: BROKEN with backoff_until NULLed.
    expect(source).toMatch(/markAccountSyncAuthFailed[\s\S]{0,400}sync_state = 'BROKEN'[\s\S]{0,400}backoff_until = NULL/);
  });

  it("enforces the account cap at create time and worker startup", async () => {
    const repository = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");
    const worker = await readFile(resolve(process.cwd(), "src/worker-runtime.ts"), "utf8");

    expect(repository).toContain("SYNC_MAX_ACCOUNTS limit reached");
    expect(worker).toContain("exceeds SYNC_MAX_ACCOUNTS");
  });

  it("limits reconciliation tombstones to the active sync window", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("AND window_status = 'IN_WINDOW'");
  });

  it("loads reconcile UIDs through a temporary table", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("CREATE TEMP TABLE supamail_live_uids");
    expect(source).toContain("ON COMMIT DROP");
    expect(source).toContain("SELECT DISTINCT unnest($1::bigint[])");
  });

  it("returns missing-in-DB UIDs from reconcile for backfill (spec §10.7 step 3)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("missingInDbUids: number[]");
    expect(source).toContain("FROM supamail_live_uids live");
    expect(source).toContain("WHERE NOT EXISTS");
  });

  it("treats PARTIAL_SUCCESS as a success for counter rules (spec §12.2)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    // PARTIAL block must increment successes, not failures, unless the cycle
    // hit the cooperative lock budget and should stay neutral for backoff.
    expect(source).toMatch(/markAccountSyncPartial[\s\S]{0,1000}WHEN \$3::boolean THEN consecutive_successes \+ 1/);
    expect(source).not.toMatch(/markAccountSyncPartial[\s\S]{0,500}consecutive_failures = consecutive_failures \+ 1/);
  });

  it("uses jittered backoff and resets the stored backoff only after stable success", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("0.7 + random() * 0.6");
    expect(source).toContain("ELSE next_backoff.base_ms");
    expect(source).toContain("consecutive_successes + 1 >= 3");
  });

  it("escalates long-stuck DEGRADED accounts without compounding exponential backoff", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("last_priority_sync_succeeded_at = now()");
    expect(source).toContain("STUCK_DEGRADED_24H");
    expect(source).toContain("STUCK_DEGRADED_TERMINAL");
    expect(source).toContain("STUCK_DEGRADED_RETRY_INTERVAL_MS");
    expect(source).toContain("WHEN stuck_state.is_stuck_degraded THEN a.consecutive_failures");
    expect(source).toContain("WHEN stuck_state.is_stuck_degraded THEN a.current_backoff_ms");
  });

  it("short-circuits AUTH_ERROR to BROKEN without backoff (spec §13.1)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("markAccountSyncAuthFailed");
    expect(source).toContain("AUTH_ERROR:");
    expect(source).toContain("sync_state = 'BROKEN'");
  });

  it("scopes UIDVALIDITY reset counter to a rolling 24h window (spec §11)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("last_uidvalidity_reset_at < now() - interval '24 hours'");
    expect(source).toContain("resetCountIn24h");
  });

  it("applies a folder-missing grace period before flipping to MISSING (spec §10.2)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("missing_since < now() - ($3::bigint * interval '1 millisecond')");
    expect(source).toContain("FOLDER_MISSING_GRACE_MS");
  });

  it("supports snapshot + watermark for initial sync (spec §10.4)", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("setInitialSyncSnapshot");
    expect(source).toContain("advanceInitialSyncWatermark");
    expect(source).toContain("initial_sync_target_max_uid = $2");
    expect(source).toContain("initial_sync_oldest_uid_synced = $3");
  });

  it("uses priority plus round-robin folder scheduling", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("MAX_PRIORITY_FOLDERS_PER_CYCLE");
    expect(source).toContain("MAX_RR_FOLDERS_PER_CYCLE");
    expect(source).toContain("folder_rr_cursor");
  });

  it("diffs flag scans and logs FLAGS_CHANGED instead of counting every refetch", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("applyFlagScan");
    expect(source).toContain("normalizeFlags");
    expect(source).toContain("FLAGS_CHANGED");
    expect(source).toContain("previousFlags");
    expect(source).toContain("nextFlags");
    expect(source).toContain("knownMessages");
  });

  it("does not body-backfill messages from untracked folders", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");

    expect(source).toContain("getBodyBacklog");
    expect(source).toContain("AND f.tracked = true");
  });

  it("runs retention as expiry first, purge second", async () => {
    const source = await readFile(resolve(process.cwd(), "src/repository.ts"), "utf8");
    const worker = await readFile(resolve(process.cwd(), "src/worker-runtime.ts"), "utf8");

    expect(source).toContain("runExpiryJob");
    expect(source).toContain("window_status = 'EXPIRED'");
    expect(source).toContain("runPurgeJob");
    expect(source).toContain("provider_deleted_at < now() - interval '30 days'");
    expect(source).toContain("deleted_reason IN ('UIDVALIDITY_RESET', 'MOVED_OUT', 'FOLDER_MISSING')");
    expect(source).not.toContain("deleted_reason IN ('UIDVALIDITY_RESET', 'MOVED_OUT', 'FOLDER_MISSING', 'RECONCILE_MISSING')");
    expect(worker).toContain("runRetentionJobs");
  });
});
