import type { EventEmitter } from "node:events";
import type { ImapFlow } from "imapflow";
import type { AppConfig } from "./config.js";
import type { PgPool } from "./db.js";
import { connectImap } from "./imap-connect.js";
import { ThrottledImapClient, type MirrorImapClient } from "./imap-client.js";
import type { ImapAccount } from "./types.js";

export type InboxIdleWakeKind = "exists" | "expunge" | "flags";

export interface InboxIdleWake {
  kind: InboxIdleWakeKind;
  accountId: string;
  folderPath: string;
  observedAt: Date;
  count?: number;
  previousCount?: number;
  sequence?: number;
  uid?: number;
}

export type InboxIdleWaitResult =
  | { status: "wake"; wake: InboxIdleWake }
  | { status: "renew" | "disconnected" };

export type InboxIdleAttemptResult =
  | ({ connectedAt: Date } & InboxIdleWaitResult)
  | { status: "unsupported"; connectedAt: Date };

interface InboxIdleClient extends Pick<EventEmitter, "on" | "removeListener"> {
  capabilities: ReadonlyMap<string, boolean | number>;
  enabled?: ReadonlySet<string>;
  mailboxOpen(path: string, options?: { readOnly?: boolean }): Promise<unknown>;
  idle(): Promise<boolean | void>;
  logout(): Promise<void>;
  close(): void;
}

export interface InboxIdleSession {
  readonly accountId: string;
  readonly connectedAt: Date;
  readonly syncClient: MirrorImapClient;
  wait(options?: { signal?: AbortSignal; now?: () => Date }): Promise<InboxIdleWaitResult>;
  close(): void;
}

export type OpenInboxIdleSessionResult =
  | { status: "ready"; session: InboxIdleSession }
  | { status: "unsupported"; connectedAt: Date };

export interface OpenInboxIdleSessionOptions {
  signal?: AbortSignal;
  now?: () => Date;
  clientFactory?: () => Promise<InboxIdleClient>;
}

function supportsIdle(client: InboxIdleClient): boolean {
  if (client.capabilities.has("IDLE")) return true;
  if (client.enabled?.has("IMAP4REV2")) return true;
  return client.capabilities.has("IMAP4rev2")
    && !client.capabilities.has("IMAP4rev1");
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("Inbox IDLE wait aborted", "AbortError");
}

class ReusableInboxIdleSession implements InboxIdleSession {
  readonly syncClient: MirrorImapClient;
  private readonly pending: InboxIdleWaitResult[] = [];
  private waiter: {
    finish(result: InboxIdleWaitResult): void;
    fail(error: unknown): void;
  } | null = null;
  private now: () => Date;
  private idleCycle = 0;
  private closed = false;

  constructor(
    readonly accountId: string,
    readonly connectedAt: Date,
    private readonly client: InboxIdleClient,
    config: AppConfig,
    signal?: AbortSignal,
    now: () => Date = () => new Date()
  ) {
    this.now = now;
    this.syncClient = new ThrottledImapClient(
      client as unknown as ImapFlow,
      config.IMAP_MAX_COMMANDS_PER_MINUTE,
      config.IMAP_COMMAND_TIMEOUT_MS,
      signal
    );
    this.client.on("exists", this.onExists);
    this.client.on("expunge", this.onExpunge);
    this.client.on("flags", this.onFlags);
    this.client.on("close", this.onClose);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.client.close();
  }

  private detach(): void {
    this.client.removeListener("exists", this.onExists);
    this.client.removeListener("expunge", this.onExpunge);
    this.client.removeListener("flags", this.onFlags);
    this.client.removeListener("close", this.onClose);
  }

  private deliver(result: InboxIdleWaitResult): void {
    if (this.waiter) {
      this.waiter.finish(result);
      return;
    }
    if (result.status === "wake") {
      const duplicate = this.pending.findIndex(
        (entry) => entry.status === "wake" && entry.wake.kind === result.wake.kind
      );
      if (duplicate >= 0) this.pending.splice(duplicate, 1);
    } else {
      this.pending.length = 0;
    }
    this.pending.push(result);
  }

  private wake(
    kind: InboxIdleWakeKind,
    data: { path?: unknown; count?: unknown; prevCount?: unknown; seq?: unknown; uid?: unknown }
  ): void {
    this.deliver({
      status: "wake",
      wake: {
        kind,
        accountId: this.accountId,
        folderPath: typeof data.path === "string" ? data.path : "INBOX",
        observedAt: this.now(),
        ...(typeof data.count === "number" ? { count: data.count } : {}),
        ...(typeof data.prevCount === "number" ? { previousCount: data.prevCount } : {}),
        ...(typeof data.seq === "number" ? { sequence: data.seq } : {}),
        ...(typeof data.uid === "number" ? { uid: data.uid } : {})
      }
    });
  }

  private readonly onExists = (data: unknown) => this.wake(
    "exists",
    data as Parameters<ReusableInboxIdleSession["wake"]>[1]
  );
  private readonly onExpunge = (data: unknown) => this.wake(
    "expunge",
    data as Parameters<ReusableInboxIdleSession["wake"]>[1]
  );
  private readonly onFlags = (data: unknown) => this.wake(
    "flags",
    data as Parameters<ReusableInboxIdleSession["wake"]>[1]
  );
  private readonly onClose = () => {
    this.closed = true;
    this.detach();
    this.deliver({ status: "disconnected" });
  };

  async wait(
    options: { signal?: AbortSignal; now?: () => Date } = {}
  ): Promise<InboxIdleWaitResult> {
    options.signal?.throwIfAborted();
    const queued = this.pending.shift();
    if (queued) return queued;
    if (this.closed) return { status: "disconnected" };
    this.now = options.now ?? this.now;
    const abortOpen = () => this.close();
    options.signal?.addEventListener("abort", abortOpen, { once: true });
    try {
      await this.client.mailboxOpen("INBOX", { readOnly: true });
      if (options.signal?.aborted) throw abortError(options.signal);
    } catch (error) {
      this.close();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abortOpen);
    }

    const selectedWake = this.pending.shift();
    if (selectedWake) return selectedWake;

    return await new Promise<InboxIdleWaitResult>((resolve, reject) => {
      let settled = false;
      const cycle = ++this.idleCycle;

      const cleanup = () => {
        options.signal?.removeEventListener("abort", onAbort);
        if (this.waiter?.finish === finish) this.waiter = null;
      };
      const finish = (result: InboxIdleWaitResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.close();
        reject(error);
      };
      const onAbort = () => fail(abortError(options.signal!));

      this.waiter = { finish, fail };
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });

      void this.client.idle().then(
        () => {
          if (cycle === this.idleCycle && !settled) finish({ status: "renew" });
        },
        (error) => {
          if (cycle !== this.idleCycle || settled) return;
          if (options.signal?.aborted) return onAbort();
          fail(error);
        }
      );
    });
  }
}

/**
 * Open one reusable, read-only Inbox IDLE session.
 *
 * The host owns listener placement, reconnect/backoff, provider permits, and
 * periodic reconciliation. A wake is only a hint. The host may pass
 * `session.syncClient` to `MirrorEngine.syncAccount` so IDLE and sync share one
 * provider session.
 */
export async function openInboxIdleSession(
  pool: PgPool,
  config: AppConfig,
  account: ImapAccount,
  options: OpenInboxIdleSessionOptions = {}
): Promise<OpenInboxIdleSessionResult> {
  options.signal?.throwIfAborted();
  const now = options.now ?? (() => new Date());
  const connected = await (options.clientFactory
    ? options.clientFactory()
    : connectImap(pool, config, account, { signal: options.signal, purpose: "idle" }));
  const client = connected as InboxIdleClient;
  const connectedAt = now();

  if (!supportsIdle(client)) {
    client.close();
    return { status: "unsupported", connectedAt };
  }

  return {
    status: "ready",
    session: new ReusableInboxIdleSession(
      account.id,
      connectedAt,
      client,
      config,
      options.signal,
      now
    )
  };
}

/** Convenience one-shot API for hosts that do not reuse the IDLE connection. */
export async function waitForInboxIdleWake(
  pool: PgPool,
  config: AppConfig,
  account: ImapAccount,
  options: OpenInboxIdleSessionOptions = {}
): Promise<InboxIdleAttemptResult> {
  const opened = await openInboxIdleSession(pool, config, account, options);
  if (opened.status === "unsupported") return opened;
  try {
    const result = await opened.session.wait(options);
    return { ...result, connectedAt: opened.session.connectedAt };
  } finally {
    opened.session.close();
  }
}
