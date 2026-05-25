import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { getConfig, type AppConfig } from "./config.js";
import { applyPublicMigrations, getPool, type PgPool } from "./db.js";
import { HostValidationError } from "./host-validation.js";
import { FolderTrackingRejectedError, MirrorRepository } from "./repository.js";
import { MirrorEngine } from "./sync-engine.js";
import type {
  AccountDetails,
  AccountSummary,
  ImapFolder,
  ImapMessage,
  SyncResult,
  UpdateAccountSettingsInput
} from "./types.js";

interface ApiRepository {
  listAccounts(): Promise<AccountSummary[]>;
  createAccount(input: unknown): Promise<AccountSummary>;
  getAccount(id: string): Promise<unknown | null>;
  getAccountDetails(id: string): Promise<AccountDetails | null>;
  updateAccountSettings(accountId: string, input: UpdateAccountSettingsInput): Promise<AccountSummary | null>;
  trackFolder(accountId: string, path: string): Promise<ImapFolder | null>;
  getMessage(id: string): Promise<ImapMessage | null>;
}

interface ApiEngine {
  syncAccount(id: string, source: "api"): Promise<SyncResult>;
  fetchBody(id: string, force?: boolean): Promise<boolean>;
}

interface ApiAppOptions {
  apiToken: string | undefined;
  adminToken?: string | null;
  repository: ApiRepository;
  engine: ApiEngine;
  applyMigration: () => Promise<void>;
}

interface StartApiServerOptions {
  config?: AppConfig;
  pool?: PgPool;
  repository?: MirrorRepository;
  engine?: MirrorEngine;
}

const UUID_SCHEMA = z.string().uuid();

const CREATE_ACCOUNT_SCHEMA = z.object({
  emailAddress: z.string().email().max(255),
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean().optional(),
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(1024),
  providerProfile: z.string().min(1).max(64).optional(),
  bodyFetchPolicy: z.enum(["immediate", "lazy", "priority_then_backfill"]).optional()
});

const TRACK_FOLDER_SCHEMA = z.object({
  path: z.string().min(1).max(1024)
});

const MUTABLE_ACCOUNT_SETTING_KEYS = [
  "historicalBackfillMode",
  "archiveRefreshInterval",
  "archiveFlagSync",
  "maxBackfillRate"
] as const;

const ACCOUNT_SETTINGS_SCHEMA = z.object({
  historicalBackfillMode: z.enum(["off", "metadata_only", "metadata_and_bodies"]).optional(),
  archiveRefreshInterval: z.enum(["never", "monthly", "weekly"]).optional(),
  archiveFlagSync: z.boolean().optional(),
  maxBackfillRate: z.enum(["small", "normal", "aggressive"]).optional(),
  liveWindowDays: z.unknown().optional(),
  live_window_days: z.unknown().optional()
}).strict().superRefine((input, ctx) => {
  const immutablePath = "liveWindowDays" in input ? "liveWindowDays" : "live_window_days" in input ? "live_window_days" : null;
  if (immutablePath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [immutablePath],
      message: "live_window_days is immutable after account creation"
    });
  }

  if (!MUTABLE_ACCOUNT_SETTING_KEYS.some((key) => input[key] !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "At least one mutable account setting is required"
    });
  }
});

class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

async function parseJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HTTPException(400, { res: c.json({ error: "invalid_json" }, 400) });
  }
}

function safeBearerEquals(received: string, expected: Buffer): boolean {
  const buf = Buffer.from(received, "utf8");
  if (buf.length !== expected.length) return false;
  return timingSafeEqual(buf, expected);
}

export function createApiApp(options: ApiAppOptions): Hono {
  if (!options.apiToken) {
    throw new Error("API_TOKEN is required to run the SupaMail API");
  }

  const app = new Hono();
  const apiTokenBuffer = Buffer.from(`Bearer ${options.apiToken}`, "utf8");
  const adminTokenBuffer = options.adminToken
    ? Buffer.from(`Bearer ${options.adminToken}`, "utf8")
    : null;

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof HostValidationError) {
      return c.json({ error: err.code, message: err.message }, 400);
    }
    if (err instanceof NotFoundError) {
      return c.json({ error: "not_found", message: err.message }, 404);
    }
    if (err instanceof FolderTrackingRejectedError) {
      return c.json({ error: err.code, message: err.message }, 400);
    }
    if (err instanceof z.ZodError) {
      return c.json({ error: "invalid_input", issues: err.issues }, 400);
    }
    const pgCode = (err as { code?: string }).code;
    if (pgCode === "23505") {
      return c.json({ error: "conflict", message: "Resource already exists" }, 409);
    }
    console.error(JSON.stringify({
      event: "api.unhandled_error",
      error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
    }));
    return c.json({ error: "internal_error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, service: "supamail" }));

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    const header = c.req.header("authorization") ?? "";

    if (c.req.path === "/migrate") {
      const expected = adminTokenBuffer ?? apiTokenBuffer;
      if (!safeBearerEquals(header, expected)) {
        return c.json({ error: "unauthorized" }, 401);
      }
      return next();
    }

    if (!safeBearerEquals(header, apiTokenBuffer)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.post("/migrate", async (c) => {
    await options.applyMigration();
    return c.json({ ok: true });
  });

  app.get("/accounts", async (c) => {
    const accounts = await options.repository.listAccounts();
    return c.json({ accounts });
  });

  app.get("/accounts/:id", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const account = await options.repository.getAccountDetails(id);
    if (!account) throw new NotFoundError(`Account not found: ${id}`);
    return c.json({ account });
  });

  app.post("/accounts", async (c) => {
    const raw = await parseJsonBody(c);
    const input = CREATE_ACCOUNT_SCHEMA.parse(raw);
    const account = await options.repository.createAccount(input);
    return c.json({ account }, 201);
  });

  app.post("/accounts/:id/sync", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const account = await options.repository.getAccount(id);
    if (!account) throw new NotFoundError(`Account not found: ${id}`);
    const result = await options.engine.syncAccount(id, "api");
    return c.json({ result });
  });

  app.post("/accounts/:id/folders/track", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const account = await options.repository.getAccount(id);
    if (!account) throw new NotFoundError(`Account not found: ${id}`);
    const raw = await parseJsonBody(c);
    const input = TRACK_FOLDER_SCHEMA.parse(raw);
    const folder = await options.repository.trackFolder(id, input.path);
    if (!folder) throw new NotFoundError(`Folder not found: ${input.path}`);
    return c.json({ folder });
  });

  app.patch("/accounts/:id/settings", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const account = await options.repository.getAccount(id);
    if (!account) throw new NotFoundError(`Account not found: ${id}`);
    const raw = await parseJsonBody(c);
    const parsed = ACCOUNT_SETTINGS_SCHEMA.parse(raw);
    const input: UpdateAccountSettingsInput = {
      historicalBackfillMode: parsed.historicalBackfillMode,
      archiveRefreshInterval: parsed.archiveRefreshInterval,
      archiveFlagSync: parsed.archiveFlagSync,
      maxBackfillRate: parsed.maxBackfillRate
    };
    const updated = await options.repository.updateAccountSettings(id, input);
    if (!updated) throw new NotFoundError(`Account not found: ${id}`);
    return c.json({ account: updated });
  });

  app.post("/messages/:id/refetch-body", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const message = await options.repository.getMessage(id);
    if (!message) throw new NotFoundError(`Message not found: ${id}`);
    const fetched = await options.engine.fetchBody(id, true);
    return c.json({ fetched });
  });

  return app;
}

export function startApiServer(options: StartApiServerOptions = {}): ReturnType<typeof serve> {
  const config = options.config ?? getConfig();
  const pool = options.pool ?? getPool();
  const repository = options.repository ?? new MirrorRepository(pool, config);
  const engine = options.engine ?? new MirrorEngine({ pool, config, repository });
  const app = createApiApp({
    apiToken: config.API_TOKEN,
    adminToken: config.ADMIN_TOKEN,
    repository,
    engine,
    applyMigration: () => applyPublicMigrations(pool)
  });

  const server = serve({ fetch: app.fetch, port: config.PORT });
  console.log(`SupaMail API listening on :${config.PORT}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startApiServer();
}
