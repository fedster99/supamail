import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getConfig } from "./config.js";
import { applyInitialMigration, getPool } from "./db.js";
import { MirrorRepository } from "./repository.js";
import { MirrorEngine } from "./sync-engine.js";

const config = getConfig();
const pool = getPool();
const repository = new MirrorRepository(pool, config);
const engine = new MirrorEngine({ pool, config, repository });
const app = new Hono();

app.use("*", async (c, next) => {
  if (!config.API_TOKEN) return next();
  const header = c.req.header("authorization") ?? "";
  if (header !== `Bearer ${config.API_TOKEN}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

app.get("/health", (c) => c.json({ ok: true, service: "imap-to-supabase" }));

app.post("/migrate", async (c) => {
  await applyInitialMigration(pool);
  return c.json({ ok: true });
});

app.get("/accounts", async (c) => {
  const accounts = await repository.listAccounts();
  return c.json({ accounts });
});

app.post("/accounts", async (c) => {
  const body = await c.req.json();
  const account = await repository.createAccount({
    emailAddress: body.emailAddress,
    host: body.host,
    port: Number(body.port),
    secure: body.secure ?? true,
    username: body.username,
    password: body.password,
    providerProfile: body.providerProfile,
    bodyFetchPolicy: body.bodyFetchPolicy
  });
  return c.json({ account }, 201);
});

app.post("/accounts/:id/sync", async (c) => {
  const result = await engine.syncAccount(c.req.param("id"), "api");
  return c.json({ result });
});

app.post("/messages/:id/refetch-body", async (c) => {
  const fetched = await engine.fetchBody(c.req.param("id"), true);
  return c.json({ fetched });
});

serve({ fetch: app.fetch, port: config.PORT });
console.log(`imap-to-supabase API listening on :${config.PORT}`);
