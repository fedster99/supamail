import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApiApp } from "../api.js";
import type { AccountDetails, AccountSummary, ImapFolder, SyncResult, UpdateAccountSettingsInput } from "../types.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const messageId = "00000000-0000-4000-8000-000000000002";

function makeAccount(overrides: Partial<AccountSummary> = {}): AccountSummary {
  const now = new Date("2026-05-19T00:00:00.000Z");
  return {
    id: accountId,
    email_address: "user@example.test",
    provider_profile: "generic-imap",
    body_fetch_policy: "lazy",
    live_window_days: 90,
    historical_backfill_mode: "metadata_and_bodies",
    archive_refresh_interval: "monthly",
    archive_flag_sync: false,
    max_backfill_rate: "normal",
    sync_state: "HEALTHY",
    sync_state_reason: null,
    last_sync_started_at: null,
    last_sync_finished_at: null,
    last_priority_sync_succeeded_at: null,
    priority_sync_lag_seconds: null,
    overall_sync_lag_seconds: null,
    consecutive_failures: 0,
    consecutive_successes: 1,
    backoff_until: null,
    last_folder_discovery_at: null,
    next_folder_discovery_at: null,
    folder_count_cap_override: null,
    last_heartbeat_at: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function makeSyncResult(): SyncResult {
  return {
    runId: "sync-run-1",
    outcome: "success",
    foldersProcessed: 1,
    messagesUpserted: 0,
    bodiesFetched: 0,
    flagsUpdated: 0,
    reconcileGapsFound: 0,
    hitLockBudget: false,
    errors: []
  };
}

function makeAccountDetails(overrides: Partial<AccountDetails> = {}): AccountDetails {
  return {
    ...makeAccount(overrides),
    live_headers_synced_count: 3,
    live_headers_target_count: 3,
    live_headers_complete_pct: 100,
    priority_bodies_fetched_count: 2,
    priority_bodies_target_count: 3,
    priority_bodies_complete_pct: 67,
    live_bodies_fetched_count: 2,
    live_bodies_target_count: 3,
    live_bodies_complete_pct: 67,
    historical_headers_synced_count: 0,
    historical_headers_target_count: 0,
    historical_headers_complete_pct: 0,
    historical_bodies_fetched_count: 0,
    historical_bodies_target_count: 0,
    historical_bodies_complete_pct: 0,
    estimated_full_sync_at: null,
    folders: [],
    ...overrides
  };
}

function makeFolder(overrides: Partial<ImapFolder> = {}): ImapFolder {
  const now = new Date("2026-05-19T00:00:00.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000003",
    account_id: accountId,
    path: "Archive",
    delimiter: "/",
    special_use: null,
    last_seen_in_provider_at: now,
    missing_since: null,
    tracked: true,
    excluded_reason: null,
    sync_priority: 100,
    status: "PENDING",
    uidvalidity: null,
    uid_next: null,
    highest_modseq: null,
    last_uid: null,
    last_synced_at: null,
    initial_sync_complete: false,
    initial_sync_target_max_uid: null,
    initial_sync_oldest_uid_synced: null,
    last_progress_at: null,
    last_progress_uid: null,
    last_progress_note: null,
    next_sync_due_at: null,
    next_flag_scan_at: null,
    next_reconcile_at: null,
    last_full_reconcile_at: null,
    last_reconcile_clean: null,
    uidvalidity_reset_count: 0,
    last_uidvalidity_reset_at: null,
    headers_synced_count: 0,
    bodies_fetched_count: 0,
    live_window_target_count: null,
    historical_target_count: null,
    backfill_in_progress: false,
    backfill_target_max_uid: null,
    backfill_oldest_uid_synced: null,
    backfill_since_date: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function buildApp(options: {
  apiToken?: string;
  adminToken?: string | null;
  account?: AccountSummary | null;
  accountDetails?: AccountDetails | null;
  trackFolder?: (accountId: string, path: string) => Promise<ImapFolder | null>;
  updateAccountSettings?: (accountId: string, input: UpdateAccountSettingsInput) => Promise<AccountSummary | null>;
  createAccount?: (input: unknown) => Promise<AccountSummary>;
  listAccounts?: () => Promise<AccountSummary[]>;
  applyMigration?: () => Promise<void>;
} = {}) {
  const account = options.account === undefined ? makeAccount() : options.account;
  const accountDetails = options.accountDetails === undefined
    ? account ? makeAccountDetails(account) : null
    : options.accountDetails;
  const repository = {
    listAccounts: vi.fn(options.listAccounts ?? (async () => account ? [account] : [])),
    createAccount: vi.fn(options.createAccount ?? (async (input: unknown) => makeAccount({
      email_address: (input as { emailAddress: string }).emailAddress
    }))),
    getAccount: vi.fn(async () => account),
    getAccountDetails: vi.fn(async () => accountDetails),
    updateAccountSettings: vi.fn(options.updateAccountSettings ?? (async (_accountId, input) => makeAccount({
      historical_backfill_mode: input.historicalBackfillMode ?? "metadata_and_bodies",
      archive_refresh_interval: input.archiveRefreshInterval ?? "monthly",
      archive_flag_sync: input.archiveFlagSync ?? false,
      max_backfill_rate: input.maxBackfillRate ?? "normal"
    }))),
    trackFolder: vi.fn(options.trackFolder ?? (async (_accountId: string, path: string) => makeFolder({ path }))),
    getMessage: vi.fn(async () => ({ id: messageId }) as never)
  };
  const engine = {
    syncAccount: vi.fn(async () => makeSyncResult()),
    fetchBody: vi.fn(async () => true)
  };
  const applyMigration = vi.fn(options.applyMigration ?? (async () => undefined));
  const app = createApiApp({
    apiToken: options.apiToken ?? "api-token",
    adminToken: "adminToken" in options ? options.adminToken : "admin-token",
    repository,
    engine,
    applyMigration
  });

  return { app, repository, engine, applyMigration };
}

function auth(token = "api-token"): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("API safety", () => {
  it("requires an API token at app construction", () => {
    expect(() => buildApp({ apiToken: "" })).toThrow("API_TOKEN is required");
  });

  it("keeps health public while protecting account routes", async () => {
    const { app, repository } = buildApp();

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true, service: "supamail" });

    const unauthorized = await app.request("/accounts");
    expect(unauthorized.status).toBe(401);
    expect(repository.listAccounts).not.toHaveBeenCalled();

    const authorized = await app.request("/accounts", { headers: auth() });
    expect(authorized.status).toBe(200);
    expect(repository.listAccounts).toHaveBeenCalledTimes(1);
  });

  it("gates POST /migrate behind ADMIN_TOKEN when set", async () => {
    const { app, applyMigration } = buildApp({ adminToken: "admin-token" });

    const apiTokenAttempt = await app.request("/migrate", {
      method: "POST",
      headers: auth("api-token")
    });
    expect(apiTokenAttempt.status).toBe(401);
    expect(applyMigration).not.toHaveBeenCalled();

    const adminAttempt = await app.request("/migrate", {
      method: "POST",
      headers: auth("admin-token")
    });
    expect(adminAttempt.status).toBe(200);
    expect(applyMigration).toHaveBeenCalledTimes(1);
  });

  it("uses API_TOKEN for POST /migrate when ADMIN_TOKEN is not set", async () => {
    const { app, applyMigration } = buildApp({ adminToken: null });

    const response = await app.request("/migrate", {
      method: "POST",
      headers: auth("api-token")
    });
    expect(response.status).toBe(200);
    expect(applyMigration).toHaveBeenCalledTimes(1);
  });

  it("validates POST /accounts input with zod before creating an account", async () => {
    const { app, repository } = buildApp();

    const invalid = await app.request("/accounts", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ emailAddress: "not-an-email", port: 993 })
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: "invalid_input" });
    expect(repository.createAccount).not.toHaveBeenCalled();

    const valid = await app.request("/accounts", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        emailAddress: "created@example.test",
        host: "imap.example.test",
        port: "993",
        username: "created@example.test",
        password: "secret"
      })
    });
    expect(valid.status).toBe(201);
    expect(repository.createAccount).toHaveBeenCalledWith(expect.objectContaining({
      emailAddress: "created@example.test",
      port: 993
    }));
  });

  it("maps not-found and unique-violation errors to API responses", async () => {
    const notFound = buildApp({ account: null });
    const missingSync = await notFound.app.request(`/accounts/${accountId}/sync`, {
      method: "POST",
      headers: auth()
    });
    expect(missingSync.status).toBe(404);
    await expect(missingSync.json()).resolves.toMatchObject({ error: "not_found" });

    const conflict = buildApp({
      createAccount: async () => {
        throw Object.assign(new Error("duplicate account"), { code: "23505" });
      }
    });
    const response = await conflict.app.request("/accounts", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        emailAddress: "dupe@example.test",
        host: "imap.example.test",
        port: 993,
        username: "dupe@example.test",
        password: "secret"
      })
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "conflict" });
  });

  it("returns account progress details from GET /accounts/:id", async () => {
    const { app, repository } = buildApp({
      accountDetails: makeAccountDetails({
        live_headers_complete_pct: 100,
        priority_bodies_complete_pct: 67,
        live_bodies_complete_pct: 67,
        folders: [{
          id: "00000000-0000-4000-8000-000000000004",
          path: "INBOX",
          tracked: true,
          status: "ACTIVE",
          sync_priority: 1,
          headers_synced_count: 3,
          bodies_fetched_count: 2,
          live_window_target_count: 3,
          historical_target_count: null,
          headers_pct: 100,
          bodies_pct: 67,
          historical_headers_pct: 0,
          historical_bodies_pct: 0
        }]
      })
    });

    const response = await app.request(`/accounts/${accountId}`, { headers: auth() });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      account: {
        id: accountId,
        live_headers_complete_pct: 100,
        priority_bodies_complete_pct: 67,
        live_bodies_complete_pct: 67,
        folders: [{ path: "INBOX", headers_pct: 100, bodies_pct: 67 }]
      }
    });
    expect(repository.getAccountDetails).toHaveBeenCalledWith(accountId);
  });

  it("validates POST /accounts/:id/folders/track input before enabling a folder", async () => {
    const { app, repository } = buildApp();

    const invalid = await app.request(`/accounts/${accountId}/folders/track`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ path: "" })
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: "invalid_input" });
    expect(repository.trackFolder).not.toHaveBeenCalled();

    const valid = await app.request(`/accounts/${accountId}/folders/track`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ path: "Archive" })
    });
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toMatchObject({ folder: { path: "Archive", tracked: true } });
    expect(repository.trackFolder).toHaveBeenCalledWith(accountId, "Archive");
  });

  it("validates PATCH /accounts/:id/settings and keeps live window immutable", async () => {
    const { app, repository } = buildApp();

    const immutable = await app.request(`/accounts/${accountId}/settings`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ liveWindowDays: 180 })
    });
    expect(immutable.status).toBe(400);
    await expect(immutable.json()).resolves.toMatchObject({ error: "invalid_input" });
    expect(repository.updateAccountSettings).not.toHaveBeenCalled();

    const invalid = await app.request(`/accounts/${accountId}/settings`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ maxBackfillRate: "fast" })
    });
    expect(invalid.status).toBe(400);
    expect(repository.updateAccountSettings).not.toHaveBeenCalled();

    const valid = await app.request(`/accounts/${accountId}/settings`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        historicalBackfillMode: "metadata_only",
        archiveRefreshInterval: "weekly",
        archiveFlagSync: true,
        maxBackfillRate: "aggressive"
      })
    });
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toMatchObject({
      account: {
        historical_backfill_mode: "metadata_only",
        archive_refresh_interval: "weekly",
        archive_flag_sync: true,
        max_backfill_rate: "aggressive",
        live_window_days: 90
      }
    });
    expect(repository.updateAccountSettings).toHaveBeenCalledWith(accountId, {
      historicalBackfillMode: "metadata_only",
      archiveRefreshInterval: "weekly",
      archiveFlagSync: true,
      maxBackfillRate: "aggressive"
    });
  });

  it("uses the SupaMail CLI name", async () => {
    const source = await readFile(resolve(process.cwd(), "src/cli.ts"), "utf8");

    expect(source).toContain('.name("supamail")');
    expect(source).not.toContain('.name("imap-to-supabase")');
  });
});
