import type { EventEmitter } from "node:events";
import type { ImapFlow } from "imapflow";
import type { AppConfig } from "./config.js";
import type { PgPool } from "./db.js";
import { connectImap } from "./imap-connect.js";
import {
  ThrottledImapClient,
  type MailboxChange,
  type MailboxChangeFeed,
  type MailboxStatus,
  type MirrorImapClient
} from "./imap-client.js";
import { MirrorRepository } from "./repository.js";
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
  usable?: boolean;
  mailboxOpen(path: string, options?: { readOnly?: boolean }): Promise<unknown>;
  status?(path: string, query: Record<string, boolean>): Promise<MailboxStatus>;
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
  folderPathsFactory?: () => Promise<string[]>;
}

const STATUS_QUERY = {
  uidValidity: true,
  uidNext: true,
  messages: true,
  unseen: true,
  highestModseq: true
} as const;

function statusValue(value: bigint | number | undefined): string | null {
  return value === undefined ? null : String(value);
}

function sameStatus(left: MailboxStatus, right: MailboxStatus): boolean {
  return statusValue(left.uidValidity) === statusValue(right.uidValidity)
    && left.uidNext === right.uidNext
    && left.messages === right.messages
    && left.unseen === right.unseen
    && statusValue(left.highestModseq) === statusValue(right.highestModseq);
}

function mailboxChange(previous: MailboxStatus, observed: MailboxStatus): MailboxChange {
  const structural = statusValue(previous.uidValidity) !== statusValue(observed.uidValidity)
    || previous.uidNext !== observed.uidNext
    || previous.messages !== observed.messages;
  const flags = statusValue(previous.highestModseq) !== statusValue(observed.highestModseq)
    || previous.unseen !== observed.unseen;
  return {
    path: observed.path,
    forceReconcile: structural,
    forceFlagScan: flags,
    observed
  };
}

class SessionMailboxChangeFeed implements MailboxChangeFeed {
  private readonly baseline = new Map<string, MailboxStatus>();
  private readonly pending = new Map<string, MailboxChange>();

  seed(statuses: readonly MailboxStatus[]): void {
    for (const status of statuses) this.baseline.set(status.path, status);
  }

  observe(status: MailboxStatus): MailboxChange | null {
    const previous = this.baseline.get(status.path);
    if (!previous) {
      this.baseline.set(status.path, status);
      const pending = this.pending.get(status.path);
      if (pending) {
        const change = { ...pending, observed: status };
        this.pending.set(status.path, change);
        return change;
      }
      return null;
    }
    const pending = this.pending.get(status.path);
    if (pending && sameStatus(pending.observed, status)) return null;
    if (sameStatus(previous, status)) return null;
    const change = mailboxChange(previous, status);
    this.pending.set(status.path, change);
    return change;
  }

  signal(path: string, forceReconcile: boolean, forceFlagScan: boolean): MailboxChange {
    const pending = this.pending.get(path);
    const change = {
      path,
      forceReconcile: forceReconcile || pending?.forceReconcile === true,
      forceFlagScan: forceFlagScan || pending?.forceFlagScan === true,
      observed: { path, uidValidity: 0 }
    };
    this.pending.set(path, change);
    return change;
  }

  retainPaths(paths: ReadonlySet<string>): void {
    for (const path of this.baseline.keys()) {
      if (path.toLowerCase() !== "inbox" && !paths.has(path)) this.baseline.delete(path);
    }
    for (const path of this.pending.keys()) {
      if (path.toLowerCase() !== "inbox" && !paths.has(path)) this.pending.delete(path);
    }
  }

  peek(limit = Number.POSITIVE_INFINITY): readonly MailboxChange[] {
    const changes = [...this.pending.values()];
    const inbox = changes.findIndex((change) => change.path.toLowerCase() === "inbox");
    if (inbox > 0) changes.unshift(...changes.splice(inbox, 1));
    return changes.slice(0, limit);
  }

  acknowledge(changes: readonly MailboxChange[]): void {
    for (const change of changes) {
      const pending = this.pending.get(change.path);
      if (pending?.observed !== change.observed) continue;
      this.baseline.set(change.path, change.observed);
      this.pending.delete(change.path);
    }
  }
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
  private probeCursor = 0;
  private acceptingEvents = false;
  private deferredInboxWake = false;
  private queuedWake: InboxIdleWake | null = null;
  private wakeDeliveryScheduled = false;
  private closed = false;

  constructor(
    readonly accountId: string,
    readonly connectedAt: Date,
    private readonly client: InboxIdleClient,
    config: AppConfig,
    private readonly folderPathsFactory: () => Promise<string[]>,
    private readonly changeFeed: SessionMailboxChangeFeed,
    private readonly probeBatchSize: number,
    private readonly statusIntervalMs: number,
    signal?: AbortSignal,
    now: () => Date = () => new Date()
  ) {
    this.now = now;
    this.syncClient = new ThrottledImapClient(
      client as unknown as ImapFlow,
      config.IMAP_MAX_COMMANDS_PER_MINUTE,
      config.IMAP_COMMAND_TIMEOUT_MS,
      signal,
      changeFeed
    );
    this.client.on("exists", this.onExists);
    this.client.on("expunge", this.onExpunge);
    this.client.on("flags", this.onFlags);
    this.client.on("close", this.onClose);
  }

  private folderPaths: string[] = [];

  private async refreshFolderPaths(): Promise<void> {
    const paths = [...new Set(await this.folderPathsFactory())]
      .filter((path) => path.toLowerCase() !== "inbox");
    if (paths.length > 0 && typeof this.client.status !== "function") {
      throw new Error("IMAP STATUS is required when folderPathsFactory returns folders");
    }
    this.folderPaths = paths;
    this.changeFeed.retainPaths(new Set(paths));
    if (this.folderPaths.length === 0) this.probeCursor = 0;
    else this.probeCursor %= this.folderPaths.length;
  }

  async initialize(): Promise<void> {
    await this.refreshFolderPaths();
    const baseline: MailboxStatus[] = [];
    for (const path of this.folderPaths) {
      try {
        baseline.push(await this.syncClient.status!(path, STATUS_QUERY));
      } catch (error) {
        if (this.client.usable === false) {
          this.close();
          throw error;
        }
        this.changeFeed.signal(path, true, true);
      }
    }
    this.changeFeed.seed(baseline);
  }

  private async probeMailboxChanges(): Promise<MailboxChange | null> {
    await this.refreshFolderPaths();
    const pending = this.changeFeed.peek(1)[0];
    if (this.folderPaths.length === 0) return pending ?? null;
    const count = Math.min(this.probeBatchSize, this.folderPaths.length);
    const paths = Array.from(
      { length: count },
      (_, index) => this.folderPaths[(this.probeCursor + index) % this.folderPaths.length]
    );
    for (const path of paths) {
      this.probeCursor = (this.probeCursor + 1) % this.folderPaths.length;
      try {
        const status = await this.syncClient.status!(path, STATUS_QUERY);
        const change = this.changeFeed.observe(status);
        if (change) return change;
      } catch (error) {
        if (this.client.usable === false) throw error;
        return this.changeFeed.signal(path, true, true);
      }
    }
    return pending ?? null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.acceptingEvents = false;
    this.queuedWake = null;
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
    const folderPath = typeof data.path === "string" ? data.path : "INBOX";
    if (!this.acceptingEvents) {
      if (!this.closed && folderPath.toLowerCase() === "inbox") {
        this.changeFeed.signal(folderPath, kind === "expunge", kind === "flags");
        this.deferredInboxWake = true;
      }
      return;
    }
    this.changeFeed.signal(
      folderPath,
      kind === "expunge",
      kind === "flags"
    );
    const wake: InboxIdleWake = {
      kind,
      accountId: this.accountId,
      folderPath,
      observedAt: this.now(),
      ...(typeof data.count === "number" ? { count: data.count } : {}),
      ...(typeof data.prevCount === "number" ? { previousCount: data.prevCount } : {}),
      ...(typeof data.seq === "number" ? { sequence: data.seq } : {}),
      ...(typeof data.uid === "number" ? { uid: data.uid } : {})
    };
    const priority: Record<InboxIdleWakeKind, number> = { exists: 1, flags: 2, expunge: 3 };
    if (!this.queuedWake || priority[wake.kind] >= priority[this.queuedWake.kind]) {
      this.queuedWake = wake;
    }
    if (this.wakeDeliveryScheduled) return;
    this.wakeDeliveryScheduled = true;
    queueMicrotask(() => {
      this.wakeDeliveryScheduled = false;
      const queued = this.queuedWake;
      this.queuedWake = null;
      if (!queued || !this.acceptingEvents || this.closed) return;
      this.deliver({ status: "wake", wake: queued });
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
    if (this.deferredInboxWake) {
      this.deferredInboxWake = false;
      const change = this.changeFeed.peek().find(
        (candidate) => candidate.path.toLowerCase() === "inbox"
      );
      if (change) {
        return {
          status: "wake",
          wake: {
            kind: change.forceReconcile ? "exists" : "flags",
            accountId: this.accountId,
            folderPath: change.path,
            observedAt: this.now()
          }
        };
      }
    }
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
      let probing = false;
      let probeTimer: ReturnType<typeof setTimeout> | undefined;
      const cycle = ++this.idleCycle;

      const cleanup = () => {
        this.acceptingEvents = false;
        if (probeTimer) clearTimeout(probeTimer);
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
      this.acceptingEvents = true;
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const probe = async () => {
        if (cycle !== this.idleCycle || settled || probing) return;
        probing = true;
        this.acceptingEvents = false;
        try {
          const change = await this.probeMailboxChanges();
          if (cycle !== this.idleCycle || settled) return;
          if (change) {
            finish({
              status: "wake",
              wake: {
                kind: change.forceReconcile ? "exists" : "flags",
                accountId: this.accountId,
                folderPath: change.path,
                observedAt: this.now()
              }
            });
          } else {
            finish({ status: "renew" });
          }
        } catch (error) {
          if (cycle !== this.idleCycle || settled) return;
          if (options.signal?.aborted) return onAbort();
          fail(error);
        }
      };

      probeTimer = setTimeout(() => void probe(), this.statusIntervalMs);
      probeTimer.unref?.();

      void this.client.idle().then(
        () => {
          if (cycle !== this.idleCycle || settled) return;
          if (!probing) finish({ status: "renew" });
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

  const repository = new MirrorRepository(pool, config);
  const folderPathsFactory = options.folderPathsFactory
    ?? (options.clientFactory
      ? async () => []
      : async () => (await repository.getTrackedFoldersForWake(account.id)).map((folder) => folder.path));
  const changeFeed = new SessionMailboxChangeFeed();
  const session = new ReusableInboxIdleSession(
    account.id,
    connectedAt,
    client,
    config,
    folderPathsFactory,
    changeFeed,
    config.MAX_PRIORITY_FOLDERS_PER_CYCLE + config.MAX_RR_FOLDERS_PER_CYCLE,
    config.IMAP_FOLDER_STATUS_INTERVAL_MS,
    options.signal,
    now
  );
  try {
    await session.initialize();
  } catch (error) {
    session.close();
    throw error;
  }

  return {
    status: "ready",
    session
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
