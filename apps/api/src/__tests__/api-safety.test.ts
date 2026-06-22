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
    last_archive_refresh_at: null,
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
  send?: (req: unknown) => Promise<unknown>;
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
  const send = vi.fn(options.send ?? (async () => ({
    rfcMessageId: "<sent@example.test>",
    delivered: true,
    appendedToSent: true,
    appendedUid: 1,
    sentFolderPath: "Sent",
    warnings: []
  })));
  const drafts = {
    create: vi.fn(async (req: { accountId: string }) => ({
      accountId: req.accountId, draftsFolderPath: "Drafts", rfcMessageId: "<draft@example.test>", appendedUid: 5
    })),
    list: vi.fn(async (_accountId: string, _opts: { limit?: number }) => [] as unknown[]),
    get: vi.fn(async (id: string) => ({
      messageId: id, accountId, folderPath: "Drafts", uid: 5, rfcMessageId: "<draft@example.test>",
      subject: "Draft", fromEmail: "user@example.test", toEmails: ["x@example.test"], ccEmails: [],
      date: "2026-05-19T00:00:00.000Z", flags: ["\\Draft"], body: "hi", inReplyTo: null, references: null
    })),
    update: vi.fn(async (id: string) => ({
      accountId, draftsFolderPath: "Drafts", rfcMessageId: "<draft2@example.test>", appendedUid: 6, replacedMessageId: id
    })),
    send: vi.fn(async (id: string) => ({
      send: { rfcMessageId: "<sent@example.test>", delivered: true, appendedToSent: true, appendedUid: 1, sentFolderPath: "Sent", warnings: [] },
      deletedDraftId: id
    })),
    delete: vi.fn(async (id: string) => ({ messageId: id, fromFolder: "Drafts" }))
  };
  const mutations = {
    setMessageFlags: vi.fn(async (id: string, change: { add?: string[]; remove?: string[] }) => ({
      messageId: id, folderPath: "INBOX", uid: 7, added: change.add ?? [], removed: change.remove ?? []
    })),
    moveMessage: vi.fn(async (id: string, folder: string) => ({
      messageId: id, fromFolder: "INBOX", toFolder: folder, newUid: 12
    })),
    deleteMessage: vi.fn(async (id: string, opts: { hard?: boolean }) => ({
      messageId: id, fromFolder: "INBOX", mode: opts.hard ? "expunge" : "trash", trashFolder: opts.hard ? null : "Trash"
    })),
    setThreadFlags: vi.fn(async (id: string, change: { add?: string[]; remove?: string[] }) => ({
      seedMessageId: id, messageCount: 2, added: change.add ?? [], removed: change.remove ?? [], messageIds: [id]
    })),
    moveThread: vi.fn(async (id: string, folder: string) => ({
      seedMessageId: id, toFolder: folder, messageCount: 2, messageIds: [id]
    })),
    createFolder: vi.fn(async (acct: string, path: string) => ({ accountId: acct, path, created: true })),
    renameFolder: vi.fn(async (acct: string, path: string, newPath: string) => ({ accountId: acct, path, newPath })),
    deleteFolder: vi.fn(async (acct: string, path: string) => ({ accountId: acct, path }))
  };
  const app = createApiApp({
    apiToken: options.apiToken ?? "api-token",
    adminToken: "adminToken" in options ? options.adminToken : "admin-token",
    repository,
    engine,
    applyMigration,
    send: send as never,
    drafts: drafts as never,
    mutations: mutations as never
  });

  return { app, repository, engine, applyMigration, send, drafts, mutations };
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

  it("gates POST /accounts/:id/send behind the API token", async () => {
    const { app, send } = buildApp();

    const unauthorized = await app.request(`/accounts/${accountId}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: [{ email: "x@example.test" }], subject: "Hi", body: { format: "plain", text: "y" } })
    });
    expect(unauthorized.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("validates the send body and dispatches the send primitive for a known account", async () => {
    const { app, send } = buildApp();

    const invalid = await app.request(`/accounts/${accountId}/send`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ subject: "Hi", body: { format: "plain", text: "y" } })
    });
    expect(invalid.status).toBe(400);
    expect(send).not.toHaveBeenCalled();

    const valid = await app.request(`/accounts/${accountId}/send`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        to: [{ email: "recipient@example.test" }],
        subject: "Hello",
        body: { format: "plain", text: "Body text" }
      })
    });
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toMatchObject({ result: { delivered: true } });
    expect(send).toHaveBeenCalledWith({
      accountId,
      to: [{ email: "recipient@example.test" }],
      subject: "Hello",
      body: { format: "plain", text: "Body text" }
    });
  });

  it("returns 404 from /send for an unknown account without dispatching", async () => {
    const { app, send } = buildApp({ account: null });

    const res = await app.request(`/accounts/${accountId}/send`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ to: [{ email: "x@example.test" }], subject: "Hi", body: { format: "plain", text: "y" } })
    });
    expect(res.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it("gates the draft routes behind the API token", async () => {
    const { app, drafts } = buildApp();
    const unauthorized = await app.request(`/accounts/${accountId}/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "Hi", body: { format: "plain", text: "y" } })
    });
    expect(unauthorized.status).toBe(401);
    expect(drafts.create).not.toHaveBeenCalled();
  });

  it("creates a draft (recipients optional) and returns 201", async () => {
    const { app, drafts } = buildApp();

    // No `to` — a draft may be saved while incomplete.
    const res = await app.request(`/accounts/${accountId}/drafts`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ subject: "Draft", body: { format: "plain", text: "hello" } })
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ result: { draftsFolderPath: "Drafts" } });
    expect(drafts.create).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, subject: "Draft", to: [] })
    );
  });

  it("rejects a draft create carrying bcc with a clear message (Bcc is send-time only)", async () => {
    const { app, drafts } = buildApp();
    const res = await app.request(`/accounts/${accountId}/drafts`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        subject: "Draft",
        bcc: [{ email: "secret@example.test" }],
        body: { format: "plain", text: "hello" }
      })
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string; issues: Array<{ message: string }> };
    expect(json.error).toBe("invalid_input");
    expect(json.issues.some((i) => i.message === "Bcc is not supported on saved drafts — set Bcc when you send the draft")).toBe(true);
    // The draft is never filed when Bcc is present.
    expect(drafts.create).not.toHaveBeenCalled();
  });

  it("returns 404 from POST /accounts/:id/drafts for an unknown account", async () => {
    const { app, drafts } = buildApp({ account: null });
    const res = await app.request(`/accounts/${accountId}/drafts`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ body: { format: "plain", text: "y" } })
    });
    expect(res.status).toBe(404);
    expect(drafts.create).not.toHaveBeenCalled();
  });

  it("lists drafts and gets a single draft from the mirror", async () => {
    const { app, drafts } = buildApp();

    const list = await app.request(`/accounts/${accountId}/drafts?limit=10`, { headers: auth() });
    expect(list.status).toBe(200);
    expect(drafts.list).toHaveBeenCalledWith(accountId, { limit: 10 });

    const get = await app.request(`/drafts/${messageId}`, { headers: auth() });
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({ draft: { messageId } });
    expect(drafts.get).toHaveBeenCalledWith(messageId);
  });

  it("returns 404 from GET /drafts/:id when the draft is unknown", async () => {
    const { app, drafts } = buildApp();
    drafts.get.mockResolvedValueOnce(null as never);
    const res = await app.request(`/drafts/${messageId}`, { headers: auth() });
    expect(res.status).toBe(404);
  });

  it("updates a draft (append-new + delete-old) via PATCH /drafts/:id", async () => {
    const { app, drafts } = buildApp();
    const res = await app.request(`/drafts/${messageId}`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ subject: "Revised", body: { format: "plain", text: "v2" } })
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ result: { replacedMessageId: messageId } });
    expect(drafts.update).toHaveBeenCalledWith(messageId, expect.objectContaining({ subject: "Revised" }));
  });

  it("sends a draft via POST /drafts/:id/send", async () => {
    const { app, drafts } = buildApp();
    const res = await app.request(`/drafts/${messageId}/send`, { method: "POST", headers: auth() });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ result: { send: { delivered: true }, deletedDraftId: messageId } });
    expect(drafts.send).toHaveBeenCalledWith(messageId);
  });

  it("maps DELETE /drafts/:id ?hard to a hard delete, default to trash", async () => {
    const { app, drafts } = buildApp();

    const trash = await app.request(`/drafts/${messageId}`, { method: "DELETE", headers: auth() });
    expect(trash.status).toBe(200);
    expect(drafts.delete).toHaveBeenLastCalledWith(messageId, { hard: false });

    const hard = await app.request(`/drafts/${messageId}?hard=true`, { method: "DELETE", headers: auth() });
    expect(hard.status).toBe(200);
    expect(drafts.delete).toHaveBeenLastCalledWith(messageId, { hard: true });
  });

  it("gates the organize-mutation routes behind the API token", async () => {
    const { app, mutations } = buildApp();
    const unauthorized = await app.request(`/messages/${messageId}/flags`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ add: ["seen"] })
    });
    expect(unauthorized.status).toBe(401);
    expect(mutations.setMessageFlags).not.toHaveBeenCalled();
  });

  it("validates and dispatches POST /messages/:id/flags for a known message", async () => {
    const { app, mutations } = buildApp();

    const empty = await app.request(`/messages/${messageId}/flags`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(empty.status).toBe(400);
    expect(mutations.setMessageFlags).not.toHaveBeenCalled();

    const ok = await app.request(`/messages/${messageId}/flags`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ add: ["seen"], remove: ["flagged"] })
    });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ result: { added: ["seen"], removed: ["flagged"] } });
    expect(mutations.setMessageFlags).toHaveBeenCalledWith(messageId, { add: ["seen"], remove: ["flagged"] });
  });

  it("returns 404 from /messages/:id/flags when the message is unknown", async () => {
    const { app, repository, mutations } = buildApp();
    repository.getMessage.mockResolvedValueOnce(null as never);
    const res = await app.request(`/messages/${messageId}/flags`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ add: ["seen"] })
    });
    expect(res.status).toBe(404);
    expect(mutations.setMessageFlags).not.toHaveBeenCalled();
  });

  it("dispatches POST /messages/:id/move with the destination folder", async () => {
    const { app, mutations } = buildApp();
    const res = await app.request(`/messages/${messageId}/move`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ folder: "Archive" })
    });
    expect(res.status).toBe(200);
    expect(mutations.moveMessage).toHaveBeenCalledWith(messageId, "Archive");
  });

  it("maps DELETE /messages/:id ?hard to a hard delete, default to trash", async () => {
    const { app, mutations } = buildApp();

    const trash = await app.request(`/messages/${messageId}`, { method: "DELETE", headers: auth() });
    expect(trash.status).toBe(200);
    expect(mutations.deleteMessage).toHaveBeenLastCalledWith(messageId, { hard: false });

    const hard = await app.request(`/messages/${messageId}?hard=true`, { method: "DELETE", headers: auth() });
    expect(hard.status).toBe(200);
    expect(mutations.deleteMessage).toHaveBeenLastCalledWith(messageId, { hard: true });
  });

  it("dispatches thread-level flags and move", async () => {
    const { app, mutations } = buildApp();

    const flags = await app.request(`/threads/${messageId}/flags`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ add: ["seen"] })
    });
    expect(flags.status).toBe(200);
    expect(mutations.setThreadFlags).toHaveBeenCalledWith(messageId, { add: ["seen"] });

    const move = await app.request(`/threads/${messageId}/move`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ folder: "Archive" })
    });
    expect(move.status).toBe(200);
    expect(mutations.moveThread).toHaveBeenCalledWith(messageId, "Archive");
  });

  it("dispatches folder CRUD and returns 404 for an unknown account", async () => {
    const { app, mutations } = buildApp();

    const create = await app.request(`/accounts/${accountId}/folders`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ path: "Projects" })
    });
    expect(create.status).toBe(201);
    expect(mutations.createFolder).toHaveBeenCalledWith(accountId, "Projects");

    const rename = await app.request(`/accounts/${accountId}/folders`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ path: "Projects", newPath: "Work" })
    });
    expect(rename.status).toBe(200);
    expect(mutations.renameFolder).toHaveBeenCalledWith(accountId, "Projects", "Work");

    const del = await app.request(`/accounts/${accountId}/folders`, {
      method: "DELETE",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ path: "Work" })
    });
    expect(del.status).toBe(200);
    expect(mutations.deleteFolder).toHaveBeenCalledWith(accountId, "Work");

    const { app: noAccountApp, mutations: noAccountMutations } = buildApp({ account: null });
    const missing = await noAccountApp.request(`/accounts/${accountId}/folders`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ path: "Projects" })
    });
    expect(missing.status).toBe(404);
    expect(noAccountMutations.createFolder).not.toHaveBeenCalled();
  });

  it("uses the SupaMail CLI name", async () => {
    const source = await readFile(resolve(process.cwd(), "src/cli.ts"), "utf8");

    expect(source).toContain('.name("supamail")');
    expect(source).not.toContain('.name("imap-to-supabase")');
  });
});
