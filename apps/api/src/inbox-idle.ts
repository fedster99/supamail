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
  skipListStatusArgs?: boolean;
  mailboxOpen(path: string, options?: { readOnly?: boolean }): Promise<unknown>;
  list?(options?: {
    statusQuery?: Record<string, boolean>;
    statusFallback?: boolean;
    mailboxPatterns?: string[];
    statusOnly?: boolean;
    returnOptionFallback?: boolean;
    cache?: boolean;
  }): Promise<Array<{
    path: string;
    status?: MailboxStatus | { error: unknown };
  }>>;
  status?(path: string, query: Record<string, boolean>): Promise<MailboxStatus>;
  notify?(mailboxes: string[]): Promise<MailboxStatus[] | false>;
  idle(): Promise<boolean | void>;
  logout(): Promise<void>;
  close(): void;
}

export interface InboxIdleSession {
  readonly accountId: string;
  readonly connectedAt: Date;
  readonly syncClient: MirrorImapClient;
  readonly folderProbeStrategy?: "notify" | "list_status" | "status";
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
  private readonly replayDepth = new Map<string, number>();

  beginReplay(path: string): void {
    this.replayDepth.set(path, (this.replayDepth.get(path) ?? 0) + 1);
  }

  endReplay(path: string): void {
    const depth = this.replayDepth.get(path) ?? 0;
    if (depth <= 1) this.replayDepth.delete(path);
    else this.replayDepth.set(path, depth - 1);
  }

  isReplaying(path: string): boolean {
    return (this.replayDepth.get(path) ?? 0) > 0;
  }

  seed(statuses: readonly MailboxStatus[]): void {
    for (const status of statuses) this.baseline.set(status.path, status);
  }

  observe(observed: Partial<MailboxStatus> & Pick<MailboxStatus, "path">): MailboxChange | null {
    const previous = this.baseline.get(observed.path);
    if (!previous) {
      if (observed.uidValidity === undefined) {
        return this.signal(observed.path, true, true);
      }
      const status = observed as MailboxStatus;
      this.baseline.set(status.path, status);
      const pending = this.pending.get(status.path);
      if (pending) {
        const change = { ...pending, observed: status };
        this.pending.set(status.path, change);
        return change;
      }
      return null;
    }
    const pending = this.pending.get(observed.path);
    const status = {
      ...previous,
      ...pending?.observed,
      ...observed,
      path: observed.path
    };
    if (pending && sameStatus(pending.observed, status)) return null;
    if (sameStatus(previous, status)) return null;
    const detected = mailboxChange(previous, status);
    const change = {
      ...detected,
      forceReconcile: detected.forceReconcile || pending?.forceReconcile === true,
      forceFlagScan: detected.forceFlagScan || pending?.forceFlagScan === true
    };
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
  return isRev2Active(client);
}

function isRev2Active(client: InboxIdleClient): boolean {
  return client.enabled?.has("IMAP4REV2") === true
    || (client.capabilities.has("IMAP4rev2") && !client.capabilities.has("IMAP4rev1"));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isPositiveIntegerLike(value: unknown): value is bigint | number {
  return typeof value === "bigint" ? value > 0n : isPositiveInteger(value);
}

function isCompleteStatus(status: MailboxStatus): boolean {
  return isPositiveIntegerLike(status.uidValidity)
    && isPositiveInteger(status.uidNext)
    && isNonNegativeInteger(status.messages)
    && isNonNegativeInteger(status.unseen);
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
  private listStatusEnabled: boolean;
  private notifyEnabled: boolean;
  private notifyPathsKey = "";
  private reconnectAfterNotifyOverflow = false;
  private deferredNotifyWake = false;
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
    this.listStatusEnabled = config.IMAP_LIST_STATUS_ENABLED
      && (client.capabilities.has("LIST-STATUS") || isRev2Active(client))
      && typeof client.list === "function";
    this.notifyEnabled = config.IMAP_NOTIFY_ENABLED
      && client.capabilities.has("NOTIFY")
      && typeof client.notify === "function";
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
    this.client.on("status", this.onStatus);
    this.client.on("notificationOverflow", this.onNotificationOverflow);
    this.client.on("close", this.onClose);
  }

  private folderPaths: string[] = [];

  get folderProbeStrategy(): "notify" | "list_status" | "status" {
    if (this.notifyEnabled) return "notify";
    return this.listStatusEnabled ? "list_status" : "status";
  }

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

  private async armNotify(): Promise<MailboxStatus[]> {
    if (!this.notifyEnabled) return [];
    const pathsKey = JSON.stringify(this.folderPaths);
    if (pathsKey === this.notifyPathsKey) return [];
    try {
      const statuses = await this.syncClient.notify!(this.folderPaths);
      if (statuses === false) {
        this.notifyEnabled = false;
        this.notifyPathsKey = "";
        return [];
      }
      this.notifyPathsKey = pathsKey;
      return statuses.filter((status) => this.folderPaths.includes(status.path));
    } catch (error) {
      const interrupted = (error instanceof DOMException && error.name === "AbortError")
        || (error instanceof Error && error.message.startsWith("IMAP_COMMAND_TIMEOUT_MS exceeded"));
      if (this.closed || interrupted || this.client.usable === false) {
        this.close();
        throw error;
      }
      this.notifyEnabled = false;
      this.notifyPathsKey = "";
      return [];
    }
  }

  async initialize(): Promise<void> {
    await this.refreshFolderPaths();
    const baseline: MailboxStatus[] = await this.armNotify();
    const notifySeen = new Set(baseline.map((status) => status.path));
    if (this.listStatusEnabled
      && this.folderPaths.length > 0
      && notifySeen.size !== this.folderPaths.length) {
      try {
        baseline.push(...await this.listStatusSnapshots());
        if (new Set(baseline.map((status) => status.path)).size !== this.folderPaths.length) {
          this.listStatusEnabled = false;
        }
      } catch (error) {
        if (this.client.usable === false) {
          this.close();
          throw error;
        }
        this.listStatusEnabled = false;
      }
    }
    const seen = new Set(baseline.map((status) => status.path));
    for (const path of this.folderPaths) {
      if (seen.has(path)) continue;
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

  private async listStatusSnapshots(): Promise<MailboxStatus[]> {
    // LIST mailbox patterns have no escape for their `*` and `%` wildcards.
    // An exact probe is therefore impossible for these otherwise legal names.
    // Keep the whole session on bounded STATUS instead of broadening the query.
    if (this.folderPaths.some((path) => /[*%]/.test(path))) {
      throw new Error("Tracked mailbox name cannot be represented as an exact LIST pattern");
    }
    const tracked = new Set(this.folderPaths);
    const statuses = await this.syncClient.listWithStatus!(STATUS_QUERY, this.folderPaths);
    if (this.client.skipListStatusArgs === true) {
      throw new Error("IMAP server rejected LIST-STATUS");
    }
    const trackedStatuses = statuses.filter((status) => tracked.has(status.path));
    if (trackedStatuses.some((status) => !isCompleteStatus(status))) {
      throw new Error("IMAP server returned incomplete LIST-STATUS data");
    }
    return trackedStatuses;
  }

  private async probeMailboxChanges(): Promise<MailboxChange | null> {
    await this.refreshFolderPaths();
    const notifyStatuses = await this.armNotify();
    let notifyChange: MailboxChange | null = null;
    for (const status of notifyStatuses) {
      const change = this.changeFeed.observe(status);
      if (!notifyChange && change) notifyChange = change;
    }
    const pending = this.changeFeed.peek(1)[0];
    if (this.notifyEnabled) return notifyChange ?? pending ?? null;
    if (this.folderPaths.length === 0) return pending ?? null;
    if (this.listStatusEnabled) {
      try {
        const statuses = await this.listStatusSnapshots();
        if (new Set(statuses.map((status) => status.path)).size !== this.folderPaths.length) {
          this.listStatusEnabled = false;
        } else {
          let firstChange: MailboxChange | null = null;
          for (const status of statuses) {
            const change = this.changeFeed.observe(status);
            if (!firstChange && change) firstChange = change;
          }
          return firstChange ?? pending ?? null;
        }
      } catch (error) {
        if (this.client.usable === false) throw error;
        this.listStatusEnabled = false;
      }
    }
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
    this.client.removeListener("status", this.onStatus);
    this.client.removeListener("notificationOverflow", this.onNotificationOverflow);
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
    if (this.changeFeed.isReplaying(folderPath)) return;
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
    this.enqueueWake(wake);
  }

  private enqueueWake(wake: InboxIdleWake): void {
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

  private readonly onStatus = (data: unknown) => {
    if (!this.notifyEnabled || !data || typeof data !== "object") return;
    const status = data as Partial<MailboxStatus> & Pick<MailboxStatus, "path">;
    if (typeof status.path !== "string"
      || status.path.toLowerCase() === "inbox"
      || !this.folderPaths.includes(status.path)) return;
    const change = this.changeFeed.observe(status);
    if (!change) return;
    if (!this.acceptingEvents) {
      this.deferredNotifyWake = true;
      return;
    }
    this.enqueueWake({
      kind: change.forceReconcile ? "exists" : "flags",
      accountId: this.accountId,
      folderPath: change.path,
      observedAt: this.now()
    });
  };

  private readonly onNotificationOverflow = () => {
    if (!this.notifyEnabled) return;
    this.notifyEnabled = false;
    this.notifyPathsKey = "";
    this.reconnectAfterNotifyOverflow = true;
    this.changeFeed.signal("INBOX", true, true);
    for (const path of this.folderPaths) {
      this.changeFeed.signal(path, true, true);
    }
    const change = this.changeFeed.peek(1)[0];
    if (!change) return;
    if (!this.acceptingEvents) {
      this.deferredNotifyWake = true;
      return;
    }
    this.enqueueWake({
      kind: "expunge",
      accountId: this.accountId,
      folderPath: change.path,
      observedAt: this.now()
    });
  };

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

  private takeDeferredWake(): InboxIdleWaitResult | null {
    if (this.reconnectAfterNotifyOverflow) {
      const overflowChange = this.changeFeed.peek(1)[0];
      if (overflowChange) {
        this.deferredNotifyWake = false;
        return {
          status: "wake",
          wake: {
            kind: overflowChange.forceReconcile ? "exists" : "flags",
            accountId: this.accountId,
            folderPath: overflowChange.path,
            observedAt: this.now()
          }
        };
      }
      this.close();
      return { status: "disconnected" };
    }
    const pendingChange = this.deferredNotifyWake ? this.changeFeed.peek(1)[0] : undefined;
    if (pendingChange) {
      this.deferredNotifyWake = false;
      return {
        status: "wake",
        wake: {
          kind: pendingChange.forceReconcile ? "exists" : "flags",
          accountId: this.accountId,
          folderPath: pendingChange.path,
          observedAt: this.now()
        }
      };
    }
    if (!this.deferredInboxWake) return null;
    this.deferredInboxWake = false;
    const inboxChange = this.changeFeed.peek().find(
      (candidate) => candidate.path.toLowerCase() === "inbox"
    );
    if (!inboxChange) return null;
    return {
      status: "wake",
      wake: {
        kind: inboxChange.forceReconcile ? "exists" : "flags",
        accountId: this.accountId,
        folderPath: inboxChange.path,
        observedAt: this.now()
      }
    };
  }

  async wait(
    options: { signal?: AbortSignal; now?: () => Date } = {}
  ): Promise<InboxIdleWaitResult> {
    options.signal?.throwIfAborted();
    const queued = this.pending.shift();
    if (queued) return queued;
    if (this.closed) return { status: "disconnected" };
    // RFC 5465 says NOTIFICATIONOVERFLOW behaves as NOTIFY NONE, including
    // suppressing the selected-mailbox events used by Inbox IDLE. Drain every
    // bounded catch-up batch before replacing this connection.
    const deferred = this.takeDeferredWake();
    if (deferred) return deferred;
    await this.refreshFolderPaths();
    for (const status of await this.armNotify()) {
      this.changeFeed.observe(status);
    }
    const armedWake = this.takeDeferredWake();
    if (armedWake) return armedWake;
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
    const selectedDeferredWake = this.takeDeferredWake();
    if (selectedDeferredWake) return selectedDeferredWake;

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
