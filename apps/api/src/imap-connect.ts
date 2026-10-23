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
 * Connect an action client (mutator, appender, content reader) under an optional
 * caller AbortSignal. The returned binding closes the socket on abort, which
 * rejects the in-flight command and every pending mailbox lock at once. Its `run`
 * refuses to start a command after abort and reports an interrupted command as
 * `AbortError`; its `logout` closes without sending LOGOUT after abort. Without a
 * signal every method behaves like the unbound client.
 */
export async function connectAbortableImap(
  pool: PgPool,
  config: AppConfig,
  account: ImapAccount,
  signal?: AbortSignal
): Promise<{ client: ImapFlow; abort: ImapAbortBinding }> {
  const client = await runAbortable(signal, () => connectImap(pool, config, account, { signal }));
  return { client, abort: new ImapAbortBinding(client, signal) };
}

/**
 * The IMAP steps of a draft save or update, named for a caller's timing. `connect`
 * covers the host check, password decryption, TLS and login; `delete` removes the
 * replaced draft, with its mirror update.
 */
export const IMAP_STEPS = ["connect", "list", "find", "append", "delete", "logout"] as const;
export type ImapStep = (typeof IMAP_STEPS)[number];
export type ImapStepTimer = (step: ImapStep, ms: number) => void;

/** Run one step and report its duration; a timer that throws never changes the step. */
export async function timeImapStep<T>(onStep: ImapStepTimer | undefined, step: ImapStep, work: () => Promise<T>): Promise<T> {
  if (!onStep) return await work();
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    try { onStep(step, performance.now() - startedAt); } catch { /* timing never changes an action */ }
  }
}

/** A connected action client and the binding that closes it on abort. */
export interface ActionSocket {
  client: ImapFlow;
  abort: ImapAbortBinding;
}

/**
 * One direct action's IMAP connection. A multi-step action (draft update, draft
 * send) opens it on first use and gives every step the same socket, so it logs in
 * once. It opens a new socket only when the last one died (an SMTP submission can
 * outlast an idle IMAP socket) and logs out once at the end.
 */
export class ActionConnection {
  private socket: ActionSocket | null = null;

  constructor(
    private readonly pool: PgPool,
    private readonly config: AppConfig,
    private readonly account: ImapAccount,
    private readonly signal?: AbortSignal,
    readonly onStep?: ImapStepTimer
  ) {}

  async get(): Promise<ActionSocket> {
    if (this.socket?.client.usable) return this.socket;
    this.socket?.abort.close();
    this.socket = null;
    this.socket = await timeImapStep(this.onStep, "connect",
      () => connectAbortableImap(this.pool, this.config, this.account, this.signal));
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

  constructor(private readonly client: ImapFlow, private readonly signal?: AbortSignal) {
    signal?.addEventListener("abort", this.closeOnAbort, { once: true });
  }

  run<T>(command: () => Promise<T>): Promise<T> {
    return runAbortable(this.signal, command);
  }

  async logout(): Promise<void> {
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
