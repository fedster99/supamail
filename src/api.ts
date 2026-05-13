import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getConfig } from "./config.js";
import { applyInitialMigration, getPool } from "./db.js";
import { HostValidationError } from "./host-validation.js";
import { MirrorRepository } from "./repository.js";
import { MirrorEngine } from "./sync-engine.js";

const config = getConfig();
const pool = getPool();
const repository = new MirrorRepository(pool, config);
const engine = new MirrorEngine({ pool, config, repository });
const app = new Hono();

if (!config.API_TOKEN) {
  throw new Error("API_TOKEN is required to run the SupaMail API");
}

const API_TOKEN_BUFFER = Buffer.from(`Bearer ${config.API_TOKEN}`, "utf8");
const ADMIN_TOKEN_BUFFER = config.ADMIN_TOKEN
  ? Buffer.from(`Bearer ${config.ADMIN_TOKEN}`, "utf8")
  : null;

function safeBearerEquals(received: string, expected: Buffer): boolean {
  const buf = Buffer.from(received, "utf8");
  if (buf.length !== expected.length) return false;
  return timingSafeEqual(buf, expected);
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

class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof HostValidationError) {
    return c.json({ error: err.code, message: err.message }, 400);
  }
  if (err instanceof NotFoundError) {
    return c.json({ error: "not_found", message: err.message }, 404);
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
    const expected = ADMIN_TOKEN_BUFFER ?? API_TOKEN_BUFFER;
    if (!safeBearerEquals(header, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  }

  if (!safeBearerEquals(header, API_TOKEN_BUFFER)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

app.post("/migrate", async (c) => {
  await applyInitialMigration(pool);
  return c.json({ ok: true });
});

app.get("/accounts", async (c) => {
  const accounts = await repository.listAccounts();
  return c.json({ accounts });
});

async function parseJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HTTPException(400, { res: c.json({ error: "invalid_json" }, 400) });
  }
}

app.post("/accounts", async (c) => {
  const raw = await parseJsonBody(c);
  const input = CREATE_ACCOUNT_SCHEMA.parse(raw);
  const account = await repository.createAccount(input);
  return c.json({ account }, 201);
});

app.post("/accounts/:id/sync", async (c) => {
  const id = UUID_SCHEMA.parse(c.req.param("id"));
  const account = await repository.getAccount(id);
  if (!account) throw new NotFoundError(`Account not found: ${id}`);
  const result = await engine.syncAccount(id, "api");
  return c.json({ result });
});

app.post("/messages/:id/refetch-body", async (c) => {
  const id = UUID_SCHEMA.parse(c.req.param("id"));
  const message = await repository.getMessage(id);
  if (!message) throw new NotFoundError(`Message not found: ${id}`);
  const fetched = await engine.fetchBody(id, true);
  return c.json({ fetched });
});

serve({ fetch: app.fetch, port: config.PORT });
console.log(`SupaMail API listening on :${config.PORT}`);
