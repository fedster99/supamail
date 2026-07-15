import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createApiApp } from "../api.js";
import { AccountBusyError, NoRecipientsError, NotFoundError, UnfetchableContentError } from "../errors.js";
import { MailboxCapabilityError, MailboxMutationError } from "../mailbox-mutations.js";
import type {
  AccountDetails,
  AccountSummary,
  ImapFolder,
  SyncResult,
  UpdateAccountCredentialsInput,
  UpdateAccountSettingsInput
} from "../types.js";

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
  updateAccountCredentials?: (
    accountId: string,
    input: UpdateAccountCredentialsInput
  ) => Promise<AccountSummary | null>;
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
    updateAccountCredentials: vi.fn(options.updateAccountCredentials ?? (async () => makeAccount({
      sync_state: "DEGRADED",
      sync_state_reason: "CREDENTIALS_UPDATED_PENDING_SYNC",
      consecutive_failures: 0,
      consecutive_successes: 0
    }))),
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
  const content = {
    listAttachments: vi.fn(async (id: string) => [
      { attachmentId: "att-1", messageId: id, filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10, partNumber: "2", contentId: null, inline: false }
    ]),
    getAttachmentMetadata: vi.fn(async (id: string) => ({
      attachmentId: id, messageId, filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10, partNumber: "2", contentId: null, inline: false
    })),
    downloadAttachment: vi.fn(async (id: string) => ({
      attachmentId: id, messageId, filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10, partNumber: "2", contentId: null, inline: false, content: Buffer.from("PDFBYTES")
    })),
    downloadAttachmentStream: vi.fn(async (id: string) => ({
      attachmentId: id, messageId, filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10, partNumber: "2", contentId: null, inline: false,
      stream: Readable.from([Buffer.from("PDFBYTES")]), close: vi.fn(async () => undefined)
    })),
    getRawMime: vi.fn(async (id: string) => ({ messageId: id, raw: Buffer.from("Subject: x\r\n\r\nbody"), source: "mirror" as const, truncated: false })),
    getMessageHeaders: vi.fn(async (id: string, _opts: { basic?: boolean }) => ({ messageId: id, headers: { "message-id": "<m@example.test>" }, source: "mirror" as const })),
    cleanMessageBody: vi.fn(async (id: string, _opts: { includeQuoted?: boolean; maxChars?: number }) => ({ messageId: id, body: "clean", truncated: false }))
  };
  const search = vi.fn(async (_req: unknown) => ({
    results: [],
    page: { limit: 25, offset: 0, returned: 0, has_more: false },
    sync_trust: { fully_synced: true, results_may_be_incomplete: false, degraded_reasons: [], accounts: [] },
    parsed_query: { free_text: "", filters: [], sort: "smart" as const, warnings: [] },
    read_only: true as const,
    timing_ms: { total: 0 }
  }));
  const app = createApiApp({
    apiToken: options.apiToken ?? "api-token",
    adminToken: "adminToken" in options ? options.adminToken : "admin-token",
    repository,
    engine,
    applyMigration,
    send: send as never,
    search: search as never,
    drafts: drafts as never,
    mutations: mutations as never,
    content: content as never
  });

  return { app, repository, engine, applyMigration, send, search, drafts, mutations, content };
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

  it("accepts POST /accounts without host/port so autodiscovery can fill them (email-008)", async () => {
    const { app, repository } = buildApp();
    const response = await app.request("/accounts", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        emailAddress: "alice@fastmail.com",
        username: "alice@fastmail.com",
        password: "secret"
      })
    });
    expect(response.status).toBe(201);
    // The route forwards the host-less input verbatim; the repository autodiscovers.
    expect(repository.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ emailAddress: "alice@fastmail.com" })
    );
    const forwarded = (repository.createAccount as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded.host).toBeUndefined();
    expect(forwarded.port).toBeUndefined();
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

  it("replaces rejected account credentials and returns a pending-sync health state", async () => {
    const { app } = buildApp();

    const response = await app.request(`/accounts/${accountId}/credentials`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ password: "new-app-password" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      account: {
        id: accountId,
        sync_state: "DEGRADED",
        sync_state_reason: "CREDENTIALS_UPDATED_PENDING_SYNC",
        consecutive_failures: 0,
        consecutive_successes: 0
      }
    });
  });

  it("rejects empty replacement credentials before touching the account", async () => {
    const { app, repository } = buildApp();

    const response = await app.request(`/accounts/${accountId}/credentials`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ password: "" })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_input" });
    expect(repository.updateAccountCredentials).not.toHaveBeenCalled();
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

  it("maps a busy direct send to 503 account_busy before delivery", async () => {
    const { app, send } = buildApp({
      send: async () => {
        throw new AccountBusyError("Account is busy syncing; retry the send shortly");
      }
    });

    const res = await app.request(`/accounts/${accountId}/send`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        to: [{ email: "x@example.test" }],
        subject: "Hi",
        body: { format: "plain", text: "y" }
      })
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    await expect(res.json()).resolves.toMatchObject({ error: "account_busy" });
    expect(send).toHaveBeenCalledTimes(1);
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

  it("passes the Idempotency-Key header through to createDraft", async () => {
    const { app, drafts } = buildApp();
    const res = await app.request(`/accounts/${accountId}/drafts`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "Idempotency-Key": "client-key-9" },
      body: JSON.stringify({ subject: "Draft", body: { format: "plain", text: "hello" } })
    });
    expect(res.status).toBe(201);
    expect(drafts.create).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, idempotencyKey: "client-key-9" })
    );
  });

  it("treats a blank/whitespace Idempotency-Key header as no key", async () => {
    const { app, drafts } = buildApp();
    const res = await app.request(`/accounts/${accountId}/drafts`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "Idempotency-Key": "   " },
      body: JSON.stringify({ subject: "Draft", body: { format: "plain", text: "hello" } })
    });
    expect(res.status).toBe(201);
    expect(drafts.create).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, idempotencyKey: undefined })
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

  it("rejects a draft create carrying attachments with a clear message (attachments are send-time only)", async () => {
    const { app, drafts } = buildApp();
    const res = await app.request(`/accounts/${accountId}/drafts`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        subject: "Draft",
        attachments: [{ filename: "report.pdf", content: "AAAA" }],
        body: { format: "plain", text: "hello" }
      })
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string; issues: Array<{ message: string }> };
    expect(json.error).toBe("invalid_input");
    expect(json.issues.some((i) => i.message === "Attachments are not supported on saved drafts — attach files when you send the draft")).toBe(true);
    // The draft is never filed when attachments are present (before any append).
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

  it("gates the content routes behind the API token", async () => {
    const { app, content } = buildApp();
    const unauthorized = await app.request(`/messages/${messageId}/attachments`);
    expect(unauthorized.status).toBe(401);
    expect(content.listAttachments).not.toHaveBeenCalled();
  });

  it("downloads an attachment with a sanitized content-disposition and the body bytes", async () => {
    const { app, content } = buildApp();
    const attachmentId = "00000000-0000-4000-8000-0000000000a1";
    // A hostile filename: quote + CR/LF + semicolon (param injection) + non-ASCII.
    content.downloadAttachmentStream.mockResolvedValueOnce({
      attachmentId, messageId, filename: 'reçu";\r\n.pdf', contentType: "application/pdf",
      sizeBytes: 8, partNumber: "2", contentId: null, inline: false,
      stream: Readable.from([Buffer.from("PDFBYTES")]), close: vi.fn(async () => undefined)
    } as never);

    const res = await app.request(`/attachments/${attachmentId}/download`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const disposition = res.headers.get("content-disposition") ?? "";
    // No CR/LF/quote/semicolon survives in the ASCII filename token (no injection).
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    const asciiToken = disposition.match(/filename="([^"]*)"/)?.[1] ?? "";
    expect(asciiToken).not.toContain('"');
    expect(asciiToken).not.toContain(";");
    // The RFC 5987 token is present so the non-ASCII name round-trips.
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toMatch(/filename\*=UTF-8''[^;\r\n]*/);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.toString()).toBe("PDFBYTES");
  });

  it("rejects an oversized multipart send part with 413", async () => {
    const { app, send } = buildApp();
    const form = new FormData();
    form.append("payload", JSON.stringify({
      to: [{ email: "r@example.test" }], subject: "Hi", body: { format: "plain", text: "y" }
    }));
    // One file part over the 25MB cap.
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    form.append("file", new File([big], "big.bin", { type: "application/octet-stream" }));

    const res = await app.request(`/accounts/${accountId}/send`, {
      method: "POST",
      headers: auth(),
      body: form
    });
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: "attachment_too_large" });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns only basic headers from GET /messages/:id/headers?basic=true", async () => {
    const { app, content } = buildApp();
    const res = await app.request(`/messages/${messageId}/headers?basic=true`, { headers: auth() });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ headers: { "message-id": "<m@example.test>" } });
    expect(content.getMessageHeaders).toHaveBeenCalledWith(messageId, { basic: true });
  });

  it("falls back to the default truncation on a non-numeric max_chars", async () => {
    const { app, content } = buildApp();
    const res = await app.request(`/messages/${messageId}/clean-body?max_chars=abc`, { headers: auth() });
    expect(res.status).toBe(200);
    // NaN must NOT reach the lib — it would disable truncation; default (undefined) instead.
    expect(content.cleanMessageBody).toHaveBeenCalledWith(messageId, { includeQuoted: false, maxChars: undefined });
  });

  it("uses the SupaMail CLI name", async () => {
    const source = await readFile(resolve(process.cwd(), "src/cli.ts"), "utf8");

    expect(source).toContain('.name("supamail")');
    expect(source).not.toContain('.name("imap-to-supabase")');
  });

  // email-005: the GET /search read route exposes the same composable filters.
  it("protects GET /search behind the API token", async () => {
    const { app, search } = buildApp();
    const res = await app.request("/search?q=invoice");
    expect(res.status).toBe(401);
    expect(search).not.toHaveBeenCalled();
  });

  it("composes the free-text q with structured field/state/date/folder filters", async () => {
    const { app, search } = buildApp();
    const res = await app.request(
      `/search?q=invoice&from=acme&to=me@x.com&cc=team@x.com&unread=true&starred=1&has_attachment=true` +
        `&received_after=2026-01-01&received_before=2026-02-01&folder=INBOX&thread=t-1&account=${accountId}` +
        `&sort=recent&limit=5&offset=10&include_body=true`,
      { headers: auth() }
    );
    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledTimes(1);
    const req = search.mock.calls[0][0] as Record<string, unknown>;
    expect(req).toMatchObject({
      q: "invoice",
      accounts: [accountId],
      sort: "recent",
      limit: 5,
      offset: 10,
      includeBody: true,
      filters: {
        from: "acme",
        to: "me@x.com",
        cc: "team@x.com",
        isUnread: true,
        isStarred: true,
        hasAttachment: true,
        after: "2026-01-01",
        before: "2026-02-01",
        folder: "INBOX",
        thread: "t-1"
      }
    });
  });

  it("accepts filters-only search (no q) and rejects an empty search", async () => {
    const { app, search } = buildApp();

    const filtersOnly = await app.request("/search?unread=true", { headers: auth() });
    expect(filtersOnly.status).toBe(200);
    expect((search.mock.calls[0][0] as { q?: string }).q).toBeUndefined();
    expect((search.mock.calls[0][0] as { filters?: unknown }).filters).toMatchObject({ isUnread: true });

    const empty = await app.request("/search", { headers: auth() });
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({ error: "invalid_input" });
  });

  it("treats an empty/whitespace ?q= with no filters as an empty search (400, not an unfiltered scan)", async () => {
    const { app, search } = buildApp();

    const emptyQ = await app.request("/search?q=", { headers: auth() });
    expect(emptyQ.status).toBe(400);
    await expect(emptyQ.json()).resolves.toMatchObject({ error: "invalid_input" });
    expect(search).not.toHaveBeenCalled();

    const whitespaceQ = await app.request("/search?q=%20%20", { headers: auth() });
    expect(whitespaceQ.status).toBe(400);
    expect(search).not.toHaveBeenCalled();

    // An empty q WITH a filter is fine: the filter alone satisfies the guard, and
    // the blank q is dropped so it never reaches the engine as a free-text scan.
    const emptyQWithFilter = await app.request("/search?q=&unread=true", { headers: auth() });
    expect(emptyQWithFilter.status).toBe(200);
    expect((search.mock.calls[0][0] as { q?: string }).q).toBeUndefined();
    expect((search.mock.calls[0][0] as { filters?: unknown }).filters).toMatchObject({ isUnread: true });
  });

  it("passes an explicit ?unread=false / ?starred=false through as a restricting filter", async () => {
    const { app, search } = buildApp();
    const res = await app.request("/search?unread=false&starred=false", { headers: auth() });
    expect(res.status).toBe(200);
    // false is forwarded (not dropped); the engine inverts it to read / not-starred.
    expect((search.mock.calls[0][0] as { filters?: unknown }).filters).toMatchObject({ isUnread: false, isStarred: false });
  });

  it("rejects an invalid account uuid on GET /search with 400", async () => {
    const { app, search } = buildApp();
    const res = await app.request("/search?q=x&account=not-a-uuid", { headers: auth() });
    expect(res.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  // ── Review PR-A: error-contract mapping (409/422/502/404/400) ─────────────
  it("maps MailboxCapabilityError to 422 capability_unsupported (not a 500)", async () => {
    const { app, mutations } = buildApp();
    mutations.deleteMessage.mockRejectedValueOnce(
      new MailboxCapabilityError("Hard delete needs the UIDPLUS extension") as never
    );
    const res = await app.request(`/messages/${messageId}?hard=true`, { method: "DELETE", headers: auth() });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      error: "capability_unsupported",
      message: expect.stringContaining("UIDPLUS")
    });
  });

  it("maps MailboxMutationError to 502 mailbox_mutation_failed (not a 500)", async () => {
    const { app, mutations } = buildApp();
    mutations.setMessageFlags.mockRejectedValueOnce(
      new MailboxMutationError("STORE +FLAGS failed for UID 42") as never
    );
    const res = await app.request(`/messages/${messageId}/flags`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ add: ["seen"] })
    });
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "mailbox_mutation_failed" });
  });

  it("still maps MailboxConflictError to 409 (regression guard for the conflict branch)", async () => {
    const { MailboxConflictError } = await import("../mailbox-mutations.js");
    const { app, mutations } = buildApp();
    mutations.moveMessage.mockRejectedValueOnce(new MailboxConflictError("UIDVALIDITY moved") as never);
    const res = await app.request(`/messages/${messageId}/move`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ folder: "Archive" })
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "mailbox_conflict" });
  });

  it("maps a typed NotFoundError from a draft route to 404 (not a 500)", async () => {
    const { app, drafts } = buildApp();
    drafts.send.mockRejectedValueOnce(new NotFoundError("Draft not found: x") as never);
    const res = await app.request(`/drafts/${messageId}/send`, { method: "POST", headers: auth() });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "not_found" });
  });

  it("maps a no-recipients send-draft to 400 (not a 500)", async () => {
    const { app, drafts } = buildApp();
    drafts.send.mockRejectedValueOnce(new NoRecipientsError("Draft has no recipients") as never);
    const res = await app.request(`/drafts/${messageId}/send`, { method: "POST", headers: auth() });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "no_recipients" });
  });

  it("maps AccountBusyError from a draft create to 503 account_busy + Retry-After (not a 500)", async () => {
    const { app, drafts } = buildApp();
    drafts.create.mockRejectedValueOnce(
      new AccountBusyError("Account is busy syncing; retry the draft shortly") as never
    );
    const res = await app.request(`/accounts/${accountId}/drafts`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ subject: "Draft", body: { format: "plain", text: "hello" } })
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    await expect(res.json()).resolves.toMatchObject({ error: "account_busy" });
  });

  it("maps an unfetchable attachment (no BODYSTRUCTURE part) to 422 (not a 500)", async () => {
    const { app, content } = buildApp();
    const attachmentId = "00000000-0000-4000-8000-0000000000b2";
    content.downloadAttachmentStream.mockRejectedValueOnce(
      new UnfetchableContentError("has no BODYSTRUCTURE part number") as never
    );
    const res = await app.request(`/attachments/${attachmentId}/download`, { headers: auth() });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: "content_unfetchable" });
  });

  // ── Review PR-A: whole-request body caps (413) on BOTH send transports ────
  it("rejects an oversized JSON send body with 413 before buffering (default transport)", async () => {
    const { app, send } = buildApp();
    // A JSON body well past the ~35MB whole-request cap. bodyLimit fires on the
    // Content-Length before parseJsonBody/json() buffers it.
    const huge = "a".repeat(36 * 1024 * 1024);
    const res = await app.request(`/accounts/${accountId}/send`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        to: [{ email: "r@example.test" }],
        subject: "Hi",
        body: { format: "plain", text: huge }
      })
    });
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: "request_too_large" });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an oversized multipart send request with 413 (whole-request cap)", async () => {
    const { app, send } = buildApp();
    const form = new FormData();
    form.append("payload", JSON.stringify({
      to: [{ email: "r@example.test" }], subject: "Hi", body: { format: "plain", text: "y" }
    }));
    // One file part over the whole-request 35MB cap (so bodyLimit fires before the
    // per-part 25MB multipart check even runs).
    const big = new Uint8Array(36 * 1024 * 1024);
    form.append("file", new File([big], "big.bin", { type: "application/octet-stream" }));

    const res = await app.request(`/accounts/${accountId}/send`, {
      method: "POST",
      headers: auth(),
      body: form
    });
    expect(res.status).toBe(413);
    expect(send).not.toHaveBeenCalled();
  });

  // ── Review PR-A: CRLF reject + flag-token charset (the header denylist
  //    itself lives in buildRawMime; see send.test.ts for that unit). ───────
  it("rejects CR/LF in a send header field (header injection guard)", async () => {
    const { app, send } = buildApp();
    for (const evil of [
      { headers: { "X-Foo": "ok\r\nBcc: leak@evil.test" } },
      { inReplyTo: "<a@b>\r\nInjected: 1" },
      { references: "<a@b>\n<c@d>" },
      { messageId: "<id@x>\r\n" }
    ]) {
      const res = await app.request(`/accounts/${accountId}/send`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({
          to: [{ email: "r@example.test" }],
          subject: "Hi",
          body: { format: "plain", text: "y" },
          ...evil
        })
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "invalid_input" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an invalid flag token charset (\\Junk Foo / control chars)", async () => {
    const { app, mutations } = buildApp();
    for (const bad of ["\\Junk Foo", "see\tn", "a;b"]) {
      const res = await app.request(`/messages/${messageId}/flags`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ add: [bad] })
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "invalid_input" });
    }
    expect(mutations.setMessageFlags).not.toHaveBeenCalled();

    // Valid tokens still pass, including RFC 5788 $-prefixed custom keywords
    // ($Forwarded, $label1) that toImapFlag passes through verbatim.
    const ok = await app.request(`/messages/${messageId}/flags`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ add: ["\\Seen", "$Forwarded", "$label1"], remove: ["flagged"] })
    });
    expect(ok.status).toBe(200);
  });

  it("caps the search offset at 5000 (deep-offset scan guard)", async () => {
    const { app, search } = buildApp();
    const over = await app.request("/search?q=x&offset=10000", { headers: auth() });
    expect(over.status).toBe(400);
    expect(search).not.toHaveBeenCalled();

    const ok = await app.request("/search?q=x&offset=5000", { headers: auth() });
    expect(ok.status).toBe(200);
  });
});
