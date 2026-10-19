import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { ImapFlow } from "imapflow";

type EventKind = "exists" | "expunge" | "flags";

type ServerConnection = {
  socket: tls.TLSSocket;
  buffer: string;
  idleTag: string | null;
  exists: number;
};

type Probe = {
  kind: EventKind;
  startedAt: number;
  expected: number;
  arrivals: Map<number, number>;
};

type ProbeResult = {
  kind: EventKind;
  expected: number;
  received: number;
  coverage: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
};

const command = process.argv[2] ?? "local";

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function log(event: string, details: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`);
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? null;
}

function openFileDescriptorCount(): number | null {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return null;
  }
}

function createCertificate(): { key: Buffer; cert: Buffer; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "supamail-idle-scale-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", certPath,
    "-days", "1",
    "-subj", "/CN=supamail-idle-scale.test"
  ], { stdio: "ignore" });
  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

function send(connection: ServerConnection, line: string): void {
  connection.socket.write(`${line}\r\n`);
}

function handleCommand(connection: ServerConnection, line: string): void {
  if (connection.idleTag && line.toUpperCase() === "DONE") {
    send(connection, `${connection.idleTag} OK IDLE completed`);
    connection.idleTag = null;
    return;
  }

  const match = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
  if (!match) return;
  const [, tag, rawCommand] = match;
  const imapCommand = rawCommand.toUpperCase();

  switch (imapCommand) {
    case "CAPABILITY":
      send(connection, "* CAPABILITY IMAP4rev1 IDLE");
      send(connection, `${tag} OK CAPABILITY completed`);
      break;
    case "LOGIN":
      send(connection, `${tag} OK LOGIN completed`);
      break;
    case "LIST":
    case "LSUB":
      send(connection, '* LIST (\\HasNoChildren \\Inbox) "/" "INBOX"');
      send(connection, `${tag} OK ${imapCommand} completed`);
      break;
    case "SELECT":
    case "EXAMINE":
      send(connection, "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)");
      send(connection, "* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)] Flags permitted");
      send(connection, `* ${connection.exists} EXISTS`);
      send(connection, "* 0 RECENT");
      send(connection, "* OK [UIDVALIDITY 1] Stable UIDs");
      send(connection, `* OK [UIDNEXT ${connection.exists + 1}] Predicted next UID`);
      send(connection, `${tag} OK [${imapCommand === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] ${imapCommand} completed`);
      break;
    case "NOOP":
      send(connection, `${tag} OK NOOP completed`);
      break;
    case "IDLE":
      connection.idleTag = tag;
      send(connection, "+ idling");
      break;
    case "UNSELECT":
    case "CLOSE":
      send(connection, `${tag} OK ${imapCommand} completed`);
      break;
    case "LOGOUT":
      send(connection, "* BYE Logging out");
      send(connection, `${tag} OK LOGOUT completed`);
      connection.socket.end();
      break;
    default:
      send(connection, `${tag} BAD Unsupported command`);
  }
}

async function startServer(): Promise<{
  imapPort: number;
  controlPort: number;
  close: () => Promise<void>;
}> {
  const imapPort = positiveInt("IDLE_SCALE_IMAP_PORT", 11_143);
  const controlPort = positiveInt("IDLE_SCALE_CONTROL_PORT", 8_080);
  const certificate = createCertificate();
  const connections = new Set<ServerConnection>();
  let accepted = 0;
  let emitted = 0;
  let dropped = 0;

  const imapServer = tls.createServer({ key: certificate.key, cert: certificate.cert }, (socket) => {
    const connection: ServerConnection = { socket, buffer: "", idleTag: null, exists: 1 };
    connections.add(connection);
    accepted += 1;
    send(connection, "* OK SupaMail IDLE scale fixture ready");

    socket.on("data", (chunk) => {
      connection.buffer += chunk.toString("utf8");
      while (connection.buffer.includes("\n")) {
        const newline = connection.buffer.indexOf("\n");
        const line = connection.buffer.slice(0, newline).replace(/\r$/, "");
        connection.buffer = connection.buffer.slice(newline + 1);
        handleCommand(connection, line);
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => connections.delete(connection));
  });

  function emit(kind: EventKind): number {
    let recipients = 0;
    for (const connection of connections) {
      if (!connection.idleTag || connection.socket.destroyed) continue;
      if (kind === "exists") {
        connection.exists += 1;
        send(connection, `* ${connection.exists} EXISTS`);
      } else if (kind === "expunge") {
        connection.exists = Math.max(0, connection.exists - 1);
        send(connection, "* 1 EXPUNGE");
      } else {
        send(connection, "* 1 FETCH (UID 1 FLAGS (\\Seen))");
      }
      recipients += 1;
    }
    emitted += recipients;
    return recipients;
  }

  const controlServer = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    response.setHeader("content-type", "application/json");

    if (url.pathname === "/event") {
      const kind = url.searchParams.get("kind") as EventKind | null;
      if (!kind || !["exists", "expunge", "flags"].includes(kind)) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "kind must be exists, expunge, or flags" }));
        return;
      }
      const sentAt = Date.now();
      const recipients = emit(kind);
      response.end(JSON.stringify({ kind, sentAt, recipients }));
      return;
    }

    if (url.pathname === "/drop") {
      const active = [...connections];
      dropped += active.length;
      response.end(JSON.stringify({ dropped: active.length, droppedAt: Date.now() }));
      setImmediate(() => active.forEach((connection) => connection.socket.destroy()));
      return;
    }

    response.end(JSON.stringify({
      status: "ok",
      active: connections.size,
      idle: [...connections].filter((connection) => connection.idleTag !== null).length,
      accepted,
      emitted,
      dropped,
      memory: process.memoryUsage()
    }));
  });

  await Promise.all([
    new Promise<void>((resolve, reject) => {
      imapServer.once("error", reject);
      imapServer.listen({ port: imapPort, host: "::", backlog: 4_096 }, () => resolve());
    }),
    new Promise<void>((resolve, reject) => {
      controlServer.once("error", reject);
      controlServer.listen(controlPort, "::", () => resolve());
    })
  ]);

  log("idle_scale.server.ready", { imapPort, controlPort });

  return {
    imapPort,
    controlPort,
    close: async () => {
      for (const connection of connections) connection.socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => imapServer.close(() => resolve())),
        new Promise<void>((resolve) => controlServer.close(() => resolve()))
      ]);
      certificate.cleanup();
    }
  };
}

async function waitFor(description: string, predicate: () => boolean, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for ${description}`);
    await delay(25);
  }
  return Date.now() - startedAt;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return await response.json() as T;
}

async function runClient(options: { localServer?: Awaited<ReturnType<typeof startServer>> } = {}): Promise<void> {
  const watcherCount = positiveInt("IDLE_SCALE_WATCHERS", 100);
  const rampConcurrency = positiveInt("IDLE_SCALE_RAMP_CONCURRENCY", 50);
  const durationMs = positiveInt("IDLE_SCALE_DURATION_MS", 60_000);
  const maxIdleTimeMs = positiveInt("IDLE_SCALE_MAX_IDLE_MS", 25 * 60_000);
  const host = process.env.IDLE_SCALE_IMAP_HOST
    ?? (options.localServer ? "127.0.0.1" : `server.process.${process.env.FLY_APP_NAME}.internal`);
  const port = positiveInt("IDLE_SCALE_IMAP_PORT", options.localServer?.imapPort ?? 11_143);
  const controlUrl = process.env.IDLE_SCALE_CONTROL_URL
    ?? `http://${options.localServer ? "127.0.0.1" : `server.process.${process.env.FLY_APP_NAME}.internal`}:${options.localServer?.controlPort ?? 8_080}`;
  const startedAt = Date.now();
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  let connected = 0;
  let peakConnected = 0;
  let totalConnections = 0;
  let connectFailures = 0;
  let sessionDisconnects = 0;
  const connectFailureReasons = new Map<string, number>();
  let catchupWakes = 0;
  let activeProbe: Probe | null = null;
  let stopping = false;
  const clients = new Set<ImapFlow>();
  const loops: Array<Promise<void>> = [];
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();

  const memorySampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 100);
  memorySampler.unref();

  function recordEvent(id: number, kind: EventKind): void {
    if (activeProbe?.kind !== kind || activeProbe.arrivals.has(id)) return;
    activeProbe.arrivals.set(id, Date.now());
  }

  async function runWatcher(id: number): Promise<void> {
    let attempt = 0;
    let connectedOnce = false;
    while (!stopping) {
      const client = new ImapFlow({
        host,
        port,
        secure: true,
        servername: "supamail-idle-scale.test",
        tls: { rejectUnauthorized: false },
        auth: { user: `watcher-${id}@example.test`, pass: "fixture", loginMethod: "LOGIN" },
        disableAutoIdle: true,
        maxIdleTime: maxIdleTimeMs,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30 * 60_000,
        logger: false
      });
      clients.add(client);
      let counted = false;
      let closed = false;
      const markClosed = () => {
        if (closed) return;
        closed = true;
        if (counted) {
          connected -= 1;
          if (!stopping) sessionDisconnects += 1;
        }
      };
      client.on("error", () => undefined);
      client.on("close", markClosed);
      client.on("exists", () => recordEvent(id, "exists"));
      client.on("expunge", () => recordEvent(id, "expunge"));
      client.on("flags", () => recordEvent(id, "flags"));

      try {
        await client.connect();
        await client.mailboxOpen("INBOX");
        connected += 1;
        counted = true;
        peakConnected = Math.max(peakConnected, connected);
        totalConnections += 1;
        if (connectedOnce) catchupWakes += 1;
        connectedOnce = true;
        attempt = 0;
        await client.idle();
      } catch (error) {
        if (!stopping && !counted) {
          connectFailures += 1;
          const candidate = error as { code?: unknown; message?: unknown };
          const reason = typeof candidate.code === "string"
            ? candidate.code
            : typeof candidate.message === "string"
              ? candidate.message.slice(0, 80)
              : "unknown";
          connectFailureReasons.set(reason, (connectFailureReasons.get(reason) ?? 0) + 1);
        }
      } finally {
        markClosed();
        clients.delete(client);
        client.close();
      }

      if (!stopping) {
        attempt += 1;
        const ceiling = Math.min(30_000, 1_000 * (2 ** Math.min(attempt - 1, 5)));
        await delay(Math.floor(Math.random() * ceiling));
      }
    }
  }

  for (let offset = 0; offset < watcherCount; offset += rampConcurrency) {
    const upper = Math.min(watcherCount, offset + rampConcurrency);
    for (let id = offset; id < upper; id += 1) loops.push(runWatcher(id));
    await delay(10);
  }

  const startupMs = await waitFor(
    `${watcherCount} connected watchers`,
    () => connected >= watcherCount,
    Math.max(60_000, watcherCount * 250)
  );
  const rssAtFull = process.memoryUsage().rss;
  log("idle_scale.client.connected", { watcherCount, startupMs, rssAtFull, host });

  async function runProbe(kind: EventKind): Promise<ProbeResult> {
    const expected = connected;
    const probe: Probe = { kind, startedAt: 0, expected, arrivals: new Map() };
    activeProbe = probe;
    const response = await requestJson<{ sentAt: number; recipients: number }>(
      `${controlUrl}/event?kind=${kind}`,
      { method: "POST" }
    );
    probe.startedAt = response.sentAt;
    probe.expected = Math.min(expected, response.recipients);
    await waitFor(
      `${kind} delivery to 95% of watchers`,
      () => probe.arrivals.size >= Math.ceil(probe.expected * 0.95),
      10_000
    );
    activeProbe = null;
    const latencies = [...probe.arrivals.values()].map((arrivedAt) => Math.max(0, arrivedAt - probe.startedAt));
    return {
      kind,
      expected: probe.expected,
      received: probe.arrivals.size,
      coverage: probe.expected === 0 ? 0 : probe.arrivals.size / probe.expected,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      maxMs: percentile(latencies, 1)
    };
  }

  const beforeDrop = [await runProbe("exists"), await runProbe("expunge"), await runProbe("flags")];
  const dropStartedAt = Date.now();
  await requestJson<{ dropped: number }>(`${controlUrl}/drop`, { method: "POST" });
  await waitFor("watchers to observe disconnect", () => connected <= Math.floor(watcherCount * 0.1), 10_000);
  await waitFor("95% watcher reconnect", () => connected >= Math.ceil(watcherCount * 0.95), 60_000);
  const reconnect95Ms = Date.now() - dropStartedAt;
  await waitFor("all watcher reconnect", () => connected >= watcherCount, 60_000);
  const reconnect100Ms = Date.now() - dropStartedAt;
  const afterReconnect = await runProbe("exists");

  const soakCpuStartedAt = process.cpuUsage();
  const soakStartedAt = Date.now();
  await delay(durationMs);
  const soakElapsedMs = Date.now() - soakStartedAt;
  const soakCpu = process.cpuUsage(soakCpuStartedAt);
  const serverStats = await requestJson<Record<string, unknown>>(`${controlUrl}/stats`);
  const openFileDescriptorsAtFull = openFileDescriptorCount();
  stopping = true;
  for (const client of clients) client.close();
  await Promise.allSettled(loops);
  clearInterval(memorySampler);
  eventLoopDelay.disable();

  const probes = [...beforeDrop, afterReconnect];
  const result = {
    watcherCount,
    startupMs,
    reconnect95Ms,
    reconnect100Ms,
    peakConnected,
    totalConnections,
    catchupWakes,
    connectFailures,
    connectFailureReasons: Object.fromEntries([...connectFailureReasons.entries()].sort()),
    sessionDisconnects,
    baselineRss,
    rssAtFull,
    peakRss,
    rssGrowthBytes: rssAtFull - baselineRss,
    rssGrowthBytesPerWatcher: Math.round((rssAtFull - baselineRss) / watcherCount),
    peakRssGrowthBytes: peakRss - baselineRss,
    peakRssGrowthBytesPerWatcher: Math.round((peakRss - baselineRss) / watcherCount),
    openFileDescriptorsAtFull,
    eventLoopDelayP95Ms: Math.round(eventLoopDelay.percentile(95) / 1_000_000),
    soakCpuPercentOfOneCore: Number((((soakCpu.user + soakCpu.system) / 1_000) / soakElapsedMs * 100).toFixed(2)),
    durationMs,
    maxIdleTimeMs,
    elapsedMs: Date.now() - startedAt,
    probes,
    serverStats,
    passed: peakConnected >= watcherCount
      && reconnect95Ms <= 30_000
      && catchupWakes >= Math.ceil(watcherCount * 0.95)
      && probes.every((probe) => probe.coverage >= 0.95 && (probe.p95Ms ?? Number.POSITIVE_INFINITY) <= 5_000)
  };
  log("idle_scale.result", result);
  if (!result.passed) process.exitCode = 1;
  const holdAfterResultMs = Number(process.env.IDLE_SCALE_HOLD_AFTER_RESULT_MS ?? 0);
  if (Number.isFinite(holdAfterResultMs) && holdAfterResultMs > 0) await delay(holdAfterResultMs);
}

async function main(): Promise<void> {
  if (command === "server") {
    const server = await startServer();
    const stop = async () => {
      await server.close();
      process.exit(0);
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    return;
  }
  if (command === "client") {
    await runClient();
    return;
  }
  if (command === "local") {
    const server = await startServer();
    try {
      await runClient({ localServer: server });
    } finally {
      await server.close();
    }
    return;
  }
  throw new Error("Usage: idle-scale [server|client|local]");
}

main().catch((error) => {
  log("idle_scale.failed", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
