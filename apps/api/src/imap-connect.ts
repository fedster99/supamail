import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import type { AppConfig } from "./config.js";
import { decryptPassword } from "./crypto.js";
import type { PgPool } from "./db.js";
import { runAbortable } from "./errors.js";
import { assertSafeImapTarget } from "./host-validation.js";
import type { ImapAccount } from "./types.js";

function safeLifecycleError(error: unknown): {
  name: string;
  code?: string;
  responseStatus?: string;
} {
  const record = error && typeof error === "object"
    ? error as { code?: unknown; responseStatus?: unknown }
    : {};
  return {
    name: error instanceof Error && error.name ? error.name : "Error",
    code: typeof record.code === "string" ? record.code : undefined,
    responseStatus: typeof record.responseStatus === "string" ? record.responseStatus : undefined
  };
}

/**
 * The one shared IMAP connect prelude (ADR 0017/0018/0020/0022). Every narrow IMAP
 * client in this codebase — the read-sync `ThrottledImapClient` (imap-client.ts),
 * the append-only `SentFolderAppender` (smtp-client.ts), the mutation
 * `MailboxMutator` (mailbox-mutations.ts), and the download/fetch `ContentImapClient`
 * (content.ts) — obtains its socket here, then wraps it with its OWN distinct verb
 * surface. This module deliberately lives OUTSIDE `src/mcp/`: it constructs an
 * ImapFlow (which can write), so it must never be importable from the zero-send
 * agent surface (`agent-surface-zero-send.test.ts`).
 *
 * The prelude owns four things that are security-/reliability-load-bearing and were
 * previously copied four times:
 *   1. `assertSafeImapTarget` — the SSRF / port / TLS guard.
 *   2. `decryptPassword` — the frozen AES-256-GCM envelope (ADR 0002).
 *   3. ImapFlow construction with the exact timeout wiring.
 *   4. The close-on-connect-error guard — if `connect()` throws (auth/TLS failure),
 *      the socket is closed before rethrowing so it cannot leak. This guard had
 *      drifted: it lived in MailboxMutator/ContentImapClient but was MISSING from
 *      createImapClient/SentFolderAppender. Centralizing it here makes all four
 *      clients fail-closed uniformly.
 *
 * Returns the raw connected {@link ImapFlow}; the caller is responsible for the
 * verb surface it exposes on top (read-only / append-only / mutate / fetch). The
 * connect/decrypt/SSRF policy can no longer drift between those clients.
 */
export async function connectImap(
  pool: PgPool,
  config: AppConfig,
  account: ImapAccount,
  options: { signal?: AbortSignal; purpose?: "command" | "idle" | "sync" } = {}
): Promise<ImapFlow> {
  await assertSafeImapTarget(account.host, account.port, account.secure, {
    allowPrivateHosts: config.IMAP_ALLOW_PRIVATE_HOSTS
  });
  const password = await decryptPassword(pool, account.encrypted_password, config.IMAP_ENCRYPTION_KEY);
  let closingIntentionally = false;
  const idleConnection = options.purpose === "idle";
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.username, pass: password },
    logger: false,
    connectionTimeout: config.CONNECT_TIMEOUT_MS,
    greetingTimeout: config.CONNECT_TIMEOUT_MS,
    socketTimeout: idleConnection
      ? config.IMAP_IDLE_SOCKET_TIMEOUT_MS
      : config.IMAP_COMMAND_TIMEOUT_MS,
    disableAutoIdle: idleConnection,
    maxIdleTime: idleConnection ? config.IMAP_IDLE_MAX_TIME_MS : undefined,
    qresync: (options.purpose === "sync" || options.purpose === "idle")
      && config.IMAP_QRESYNC_ENABLED
  });
  // ImapFlow reports some lifecycle failures through both the command/connect
  // promise and EventEmitter's special `error` channel. A scheduler abort can
  // close a pending connection after the server greeting has already queued
  // authentication; that late continuation then emits "Already logged out".
  // Without a listener Node treats the event itself as an uncaught exception,
  // bypassing the promise rejection that the caller already handles.
  client.on("error", (error: unknown) => {
    if (closingIntentionally) return;
    console.error(JSON.stringify({
      event: "imap.client.error",
      error: safeLifecycleError(error)
    }));
  });
  if (options.signal?.aborted) {
    closingIntentionally = true;
    client.close();
    throw new Error("IMAP connection interrupted for higher-priority sync work");
  }
  let interruptConnect: (() => void) | null = null;
  const interrupted = options.signal
    ? new Promise<never>((_, reject) => {
      interruptConnect = () => {
        closingIntentionally = true;
        client.close();
        reject(new Error("IMAP connection interrupted for higher-priority sync work"));
      };
      options.signal?.addEventListener("abort", interruptConnect, { once: true });
    })
    : null;
  try {
    await (interrupted ? Promise.race([client.connect(), interrupted]) : client.connect());
  } catch (error) {
    // Close the socket so an auth/TLS failure during connect cannot leak it.
    if (!closingIntentionally) {
      closingIntentionally = true;
      client.close();
    }
    throw error;
  } finally {
    if (interruptConnect) {
      options.signal?.removeEventListener("abort", interruptConnect);
    }
  }
  return client;
}

/**
 * Where a host keeps signed-in action sessions between direct actions (ADR 0051).
 * `take` removes and returns the session parked under `key`, or null; `park` keeps
 * a healthy session for that key's next action, and the host closes it when it
 * expires. Keys come from core and change with the account's server or credentials.
 * Without a store, every action logs in and logs out.
 */
export interface ActionSessionStore {
  take(key: string): ImapFlow | null;
  park(key: string, client: ImapFlow): void;
}

/** Caller controls for an action's IMAP connection. */
export interface ActionConnectOptions {
  signal?: AbortSignal;
  sessions?: ActionSessionStore;
}

/** A parked session that does not answer NOOP within this bound is replaced by a new login. */
export const SESSION_REUSE_CHECK_MS = 5_000;

/** A session parks only under the account's exact server and credentials, so a
 * changed password or host can never reuse a session from before the change. */
function actionSessionKey(account: ImapAccount): string {
  return createHash("sha256")
    .update(JSON.stringify([account.id, account.host, account.port, account.secure, account.username]))
    .update(account.encrypted_password)
    .digest("hex");
}

/** True when a parked session still answers. A session that fails, stalls or whose
 * action aborts during the check is closed. */
async function answersNoop(client: ImapFlow, signal?: AbortSignal): Promise<boolean> {
  const close = () => client.close();
  const stalled = setTimeout(close, SESSION_REUSE_CHECK_MS);
  signal?.addEventListener("abort", close, { once: true });
  try {
    await client.noop();
  } catch {
    client.close();
  } finally {
    clearTimeout(stalled);
    signal?.removeEventListener("abort", close);
  }
  return client.usable;
}

/**
 * Connect an action client (mutator, appender, content reader) under an optional
 * caller AbortSignal. The returned binding closes the socket on abort, which
 * rejects the in-flight command and every pending mailbox lock at once. Its `run`
 * refuses to start a command after abort and reports an interrupted command as
 * `AbortError`; its `logout` closes without sending LOGOUT after abort. Without a
 * signal every method behaves like the unbound client.
 *
 * With a session store, a parked session that answers NOOP is used instead of a new
 * login (`reused`), and logout parks a still-usable session instead of ending it.
 */
export async function connectAbortableImap(
  pool: PgPool,
  config: AppConfig,
  account: ImapAccount,
  { signal, sessions }: ActionConnectOptions = {}
): Promise<ActionSocket> {
  let park: ((client: ImapFlow) => void) | undefined;
  if (sessions) {
    const key = actionSessionKey(account);
    park = (client) => sessions.park(key, client);
    const parked = sessions.take(key);
    if (parked && !signal?.aborted && await answersNoop(parked, signal)) {
      return { client: parked, abort: new ImapAbortBinding(parked, signal, park), reused: true };
    }
    parked?.close();
  }
  const client = await runAbortable(signal, () => connectImap(pool, config, account, { signal }));
  return { client, abort: new ImapAbortBinding(client, signal, park), reused: false };
}

/**
 * The IMAP steps of a draft save or update, named for a caller's timing. `connect`
 * covers the host check, password decryption, TLS and login; `reuse` checks a
 * parked session instead (ADR 0051); `mirror` reads the filed UID back and stores
 * its row and body (ADR 0046); `delete` removes the replaced draft, with its
 * mirror update.
 */
export const IMAP_STEPS = ["connect", "reuse", "list", "find", "append", "mirror", "delete", "logout"] as const;
export type ImapStep = (typeof IMAP_STEPS)[number];
export type ImapStepTimer = (step: ImapStep, ms: number) => void;

function reportImapStep(onStep: ImapStepTimer | undefined, step: ImapStep, startedAt: number): void {
  try { onStep?.(step, performance.now() - startedAt); } catch { /* timing never changes an action */ }
}

/** Run one step and report its duration; a timer that throws never changes the step. */
export async function timeImapStep<T>(onStep: ImapStepTimer | undefined, step: ImapStep, work: () => Promise<T>): Promise<T> {
  if (!onStep) return await work();
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    reportImapStep(onStep, step, startedAt);
  }
}

/** A connected action client, the binding that closes it on abort, and whether it
 * was a parked session rather than a new login. */
export interface ActionSocket {
  client: ImapFlow;
  abort: ImapAbortBinding;
  reused: boolean;
}

/**
 * One direct action's IMAP connection. A multi-step action (draft update, draft
 * send) opens it on first use and gives every step the same socket, so it logs in
 * once. It opens a new socket only when the last one died (an SMTP submission can
 * outlast an idle IMAP socket) and logs out once at the end.
 */
export class ActionConnection {
  private socket: ActionSocket | null = null;
  readonly onStep?: ImapStepTimer;

  constructor(
    private readonly pool: PgPool,
    private readonly config: AppConfig,
    private readonly account: ImapAccount,
    private readonly options: ActionConnectOptions & { onImapStep?: ImapStepTimer } = {}
  ) {
    this.onStep = options.onImapStep;
  }

  async get(): Promise<ActionSocket> {
    if (this.socket?.client.usable) return this.socket;
    this.socket?.abort.close();
    this.socket = null;
    const startedAt = performance.now();
    let step: ImapStep = "connect";
    try {
      this.socket = await connectAbortableImap(this.pool, this.config, this.account, this.options);
      if (this.socket.reused) step = "reuse";
    } finally {
      reportImapStep(this.onStep, step, startedAt);
    }
    return this.socket;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (socket) await timeImapStep(this.onStep, "logout", () => closeImap(socket.abort));
  }
}

export class ImapAbortBinding {
  private readonly closeOnAbort = () => this.client.close();

  constructor(
    private readonly client: ImapFlow,
    private readonly signal?: AbortSignal,
    private readonly park?: (client: ImapFlow) => void
  ) {
    signal?.addEventListener("abort", this.closeOnAbort, { once: true });
  }

  run<T>(command: () => Promise<T>): Promise<T> {
    return runAbortable(this.signal, command);
  }

  /** End the action's use of the session: park it when a store keeps sessions and it
   * is still usable, close it after abort, and otherwise send LOGOUT. Every caller
   * awaits its commands first, so a parked session has none in flight. */
  async logout(): Promise<void> {
    if (this.park && this.client.usable && !this.signal?.aborted) {
      this.signal?.removeEventListener("abort", this.closeOnAbort);
      try { this.park(this.client); } catch { this.client.close(); }
      return;
    }
    try {
      if (this.signal?.aborted) this.client.close();
      else await this.client.logout();
    } finally {
      this.signal?.removeEventListener("abort", this.closeOnAbort);
    }
  }

  close(): void {
    this.signal?.removeEventListener("abort", this.closeOnAbort);
    this.client.close();
  }
}

/**
 * A client that can be torn down: a graceful IMAP LOGOUT, falling back to a hard
 * socket close. The narrow write/fetch clients (SentFolderAppender, MailboxMutator,
 * ContentImapClient) each expose exactly this pair, so {@link closeImap} can tear
 * any of them down uniformly.
 */
export interface ClosableImapClient {
  logout(): Promise<void>;
  close(): void | Promise<void>;
}

/**
 * The one shared IMAP teardown twin of {@link connectImap} (review maintainability
 * finding): try a graceful LOGOUT, and if that rejects (already-broken socket, a
 * timed-out command) fall back to a hard `close()` so the socket can never leak.
 * This `await client.logout().catch(() => client.close())` was copy-pasted ~13×
 * across the appender / mutator / fetch clients; centralizing it keeps the
 * disconnect policy from drifting the way the connect prelude already prevents for
 * connect. Behavior is byte-identical to the inlined teardown it replaces.
 */
export async function closeImap(client: ClosableImapClient): Promise<void> {
  try {
    await client.logout();
  } catch {
    await client.close();
  }
}

/**
 * The one shared UIDVALIDITY fail-closed comparison (CC-4, co-located with the
 * connector). The mutate path (`MailboxMutator.withUidScope`) and the on-demand
 * fetch path (`ContentImapClient.assertUidValidity`) implement the SAME property —
 * "a UIDVALIDITY reset must never let us act on / fetch the wrong message" — so the
 * comparison + message live here once.
 *
 * Returns `true` when the live mailbox UIDVALIDITY still matches what we mirrored
 * (or no mailbox is selected); returns `false` on a mismatch. Both the mutate and
 * fetch call sites throw `MailboxConflictError` (→ HTTP 409). `verb` tunes the
 * message ("mutate" / "fetch").
 */
export function uidValidityMatches(
  mailbox: { uidValidity?: bigint | number } | false | null | undefined,
  expectedUidValidity: number
): boolean {
  if (!mailbox) return true;
  return Number(mailbox.uidValidity) === expectedUidValidity;
}

/**
 * Build the standard UIDVALIDITY-mismatch message. Shared so the read and mutate
 * paths describe the same fail-closed condition identically; `verb` is the action
 * being refused ("mutate" / "fetch").
 */
export function uidValidityMismatchMessage(
  folderPath: string,
  expectedUidValidity: number,
  serverUidValidity: bigint | number | undefined,
  verb: string
): string {
  return `UIDVALIDITY changed for ${folderPath} (mirror ${expectedUidValidity} != server ${serverUidValidity}); refusing to ${verb} by stale UID`;
}
