import type { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { ImapFlow } from "imapflow";
import type { AppConfig } from "./config.js";
import type { PgPool } from "./db.js";
import { connectImap } from "./imap-connect.js";
import {
  ThrottledImapClient,
  type ImapNotifySignal,
  type MailboxChange,
  type MailboxChangeObservation,
  type MailboxChangeFeed,
  type MailboxStatus,
  type MirrorImapClient
} from "./imap-client.js";
import { MirrorRepository } from "./repository.js";
import type { ImapAccount, ImapFolder } from "./types.js";

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
  notifySignal?: ImapNotifySignal;
}

interface InboxIdleNotifyTraceBase {
  observedAt: Date;
  monotonicObservedAtMs: number;
  notifyArmed: boolean;
  notifyGeneration: number;
}

type InboxIdleNotifyTraceDetail =
  | {
      stage: "notify_state";
      reason: "armed" | "disabled" | "unsupported" | "rejected" | "overflow" | "closed";
    }
  | { stage: "response_received"; signal: ImapNotifySignal }
  | { stage: "imapflow_event_created"; signal: ImapNotifySignal; folderPath: string }
  | {
      stage: "handoff";
      signal: ImapNotifySignal;
      folderPath: string;
      result: "emitted" | "coalesced" | "ignored" | "dropped";
      reason:
        | "wake_delivered"
        | "deferred_wake_delivered"
        | "replay_in_progress"
        | "deferred_replaced"
        | "covered_by_reconciliation"
        | "session_closed"
        | "connection_closed"
        | "not_accepting_events"
        | "superseded"
        | "lower_priority"
        | "notify_disabled"
        | "inbox_status"
        | "untracked_folder"
        | "unchanged"
        | "no_dirty_folder";
    };

export type InboxIdleNotifyTrace = InboxIdleNotifyTraceBase & InboxIdleNotifyTraceDetail;

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
  mailbox?: MailboxStatus | false | null;
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
  readonly folderVerificationStrategy?: "list_status" | "status";
  verifyMailboxChanges?(): Promise<InboxIdleWake | null>;
  wait(options?: { signal?: AbortSignal; now?: () => Date }): Promise<InboxIdleWaitResult>;
  close(): void;
}

export type OpenInboxIdleSessionResult =
  | { status: "ready"; session: InboxIdleSession }
  | { status: "unsupported"; connectedAt: Date };

type InitialFolderStatus = Partial<MailboxStatus> & Pick<MailboxStatus, "path"> & {
  qresyncHighestModseq?: bigint | number;
  reconnectCursor?: boolean;
};

export interface OpenInboxIdleSessionOptions {
  signal?: AbortSignal;
  now?: () => Date;
  clientFactory?: () => Promise<InboxIdleClient>;
  folderPathsFactory?: () => Promise<string[]>;
  initialFolderStatuses?: InitialFolderStatus[];
  onNotifyTrace?: (trace: InboxIdleNotifyTrace) => void;
}

function persistedFolderStatus(folder: ImapFolder): InitialFolderStatus {
  return {
    path: folder.path,
    uidValidity: folder.uidvalidity === null ? undefined : BigInt(folder.uidvalidity),
    uidNext: folder.uid_next === null ? undefined : Number(folder.uid_next),
    highestModseq: folder.highest_modseq === null ? undefined : BigInt(folder.highest_modseq),
    qresyncHighestModseq: folder.qresync_highest_modseq === null
      ? undefined
      : BigInt(folder.qresync_highest_modseq),
    reconnectCursor: true
  };
}

const STATUS_QUERY = {
  uidValidity: true,
  uidNext: true,
  messages: true,
  unseen: true,
  highestModseq: true
} as const;

const NOTIFY_EVENT_TYPES = new Set<ImapNotifySignal["eventType"]>([
  "EXISTS",
  "EXPUNGE",
  "FETCH_FLAGS",
  "STATUS",
  "NOTIFICATIONOVERFLOW"
]);

const WAKE_PRIORITY: Record<InboxIdleWakeKind, number> = {
  exists: 1,
  flags: 2,
  expunge: 3
};

function statusValue(value: bigint | number | undefined): string | null {
  return value === undefined ? null : String(value);
}

function knownValueChanged(
  previous: bigint | number | undefined,
  observed: bigint | number | undefined
): boolean {
  return previous !== undefined
    && observed !== undefined
    && statusValue(previous) !== statusValue(observed);
}

function sameKnownStatus(previous: InitialFolderStatus, observed: MailboxStatus): boolean {
  return !knownValueChanged(previous.uidValidity, observed.uidValidity)
    && !knownValueChanged(previous.uidNext, observed.uidNext)
    && !knownValueChanged(previous.messages, observed.messages)
    && !knownValueChanged(previous.unseen, observed.unseen)
    && !knownValueChanged(previous.highestModseq, observed.highestModseq);
}

function mailboxChange(previous: InitialFolderStatus, observed: MailboxStatus): MailboxChange {
  const modseqChanged = knownValueChanged(previous.highestModseq, observed.highestModseq);
  const structural = knownValueChanged(previous.uidValidity, observed.uidValidity)
    || knownValueChanged(previous.uidNext, observed.uidNext)
    || knownValueChanged(previous.messages, observed.messages)
    // Persisted folder cursors do not include MESSAGES. A MODSEQ change while
    // disconnected can therefore be an expunge, so retain exact reconciliation.
    || (previous.messages === undefined && modseqChanged);
  const flags = modseqChanged || knownValueChanged(previous.unseen, observed.unseen);
  return {
    path: observed.path,
    forceReconcile: structural,
    forceFlagScan: flags,
    observed
  };
}

class SessionMailboxChangeFeed implements MailboxChangeFeed {
  private readonly baseline = new Map<string, InitialFolderStatus>();
  private readonly pending = new Map<string, MailboxChange>();
  private readonly replayDepth = new Map<string, number>();
  private readonly unverifiableEventFlagPaths = new Set<string>();
  private readonly unverifiedFlagStatusPaths = new Set<string>();
  private readonly unverifiableReconcilePaths = new Set<string>();
  private initializing = true;

  constructor(private readonly qresyncDeletionHistory: boolean) {}

  finishInitialization(): void {
    this.initializing = false;
  }

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

  seed(statuses: readonly InitialFolderStatus[]): void {
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
    if (status.uidValidity === undefined) {
      return this.signal(observed.path, true, true);
    }
    const {
      qresyncHighestModseq: _qresyncHighestModseq,
      reconnectCursor: _reconnectCursor,
      ...providerStatus
    } = status;
    const completeStatus = providerStatus as MailboxStatus;
    if (pending && sameKnownStatus(pending.observed, completeStatus)) {
      if (this.initializing) {
        this.pending.set(observed.path, { ...pending, observed: completeStatus });
      }
      return null;
    }
    // Persisted folder state has no MESSAGES/UNSEEN snapshot. Only a
    // deletion-complete QRESYNC cursor can prove that no expunge occurred;
    // the flag-only CONDSTORE cursor cannot. Otherwise reconcile this folder
    // once and retain the real provider snapshot after acknowledgement.
    if (!pending && previous.reconnectCursor === true) {
      const hasComparableModseq = previous.highestModseq !== undefined
        && completeStatus.highestModseq !== undefined;
      const deletionCursorIsCurrent = this.qresyncDeletionHistory
        && previous.qresyncHighestModseq !== undefined
        && completeStatus.highestModseq !== undefined
        && statusValue(previous.qresyncHighestModseq) === statusValue(completeStatus.highestModseq);
      if (!deletionCursorIsCurrent) {
        const detected = mailboxChange(previous, completeStatus);
        const change = {
          ...detected,
          forceReconcile: true,
          forceFlagScan: detected.forceFlagScan || !hasComparableModseq
        };
        this.pending.set(observed.path, change);
        return change;
      }
    }
    if (!pending && sameKnownStatus(previous, completeStatus)) {
      this.baseline.set(observed.path, completeStatus);
      return null;
    }
    const detected = mailboxChange(previous, completeStatus);
    const change = {
      ...detected,
      forceReconcile: detected.forceReconcile || pending?.forceReconcile === true,
      forceFlagScan: detected.forceFlagScan || pending?.forceFlagScan === true
    };
    this.pending.set(status.path, change);
    return change;
  }

  signal(
    path: string,
    forceReconcile: boolean,
    forceFlagScan: boolean,
    observed: Partial<MailboxStatus> = {}
  ): MailboxChange {
    const pending = this.pending.get(path);
    const previous = this.baseline.get(path);
    const change = {
      path,
      forceReconcile: forceReconcile || pending?.forceReconcile === true,
      forceFlagScan: forceFlagScan || pending?.forceFlagScan === true,
      observed: {
        ...previous,
        ...pending?.observed,
        ...observed,
        path,
        uidValidity: observed.uidValidity
          ?? pending?.observed.uidValidity
          ?? previous?.uidValidity
          ?? 0
      }
    };
    this.pending.set(path, change);
    return change;
  }

  signalEvent(
    path: string,
    kind: InboxIdleWakeKind,
    data: { count?: unknown; modseq?: unknown }
  ): MailboxChange {
    const previous = this.pending.get(path)?.observed ?? this.baseline.get(path);
    const observed: Partial<MailboxStatus> = {};
    if (kind === "exists" && isNonNegativeInteger(data.count)) {
      observed.messages = data.count;
      observed.exists = data.count;
    } else if (kind === "expunge" && typeof previous?.messages === "number") {
      observed.messages = Math.max(0, previous.messages - 1);
      observed.exists = observed.messages;
    } else if (kind === "flags"
      && (typeof data.modseq === "bigint" || isNonNegativeInteger(data.modseq))) {
      observed.highestModseq = data.modseq;
    }
    const change = this.signal(path, kind === "expunge", kind === "flags", observed);
    if (kind === "flags" && observed.highestModseq === undefined) {
      this.unverifiableEventFlagPaths.add(path);
    }
    return change;
  }

  retainPaths(paths: ReadonlySet<string>): void {
    for (const path of this.baseline.keys()) {
      if (path.toLowerCase() !== "inbox" && !paths.has(path)) this.baseline.delete(path);
    }
    for (const path of this.pending.keys()) {
      if (path.toLowerCase() !== "inbox" && !paths.has(path)) this.pending.delete(path);
    }
    for (const path of this.unverifiableEventFlagPaths) {
      if (path.toLowerCase() !== "inbox" && !paths.has(path)) {
        this.unverifiableEventFlagPaths.delete(path);
      }
    }
    for (const path of this.unverifiedFlagStatusPaths) {
      if (path.toLowerCase() !== "inbox" && !paths.has(path)) {
        this.unverifiedFlagStatusPaths.delete(path);
      }
    }
    for (const path of this.unverifiableReconcilePaths) {
      if (path.toLowerCase() !== "inbox" && !paths.has(path)) {
        this.unverifiableReconcilePaths.delete(path);
      }
    }
  }

  peek(limit = Number.POSITIVE_INFINITY): readonly MailboxChange[] {
    const changes = [...this.pending.values()];
    const inbox = changes.findIndex((change) => change.path.toLowerCase() === "inbox");
    if (inbox > 0) changes.unshift(...changes.splice(inbox, 1));
    return changes.slice(0, limit);
  }

  acknowledge(changes: readonly MailboxChange[]): void {
    this.acknowledgeWithStatuses(changes, []);
  }

  acknowledgeWithStatuses(
    changes: readonly MailboxChange[],
    observations: readonly MailboxChangeObservation[]
  ): void {
    const observationByPath = new Map(
      observations.map((observation) => [observation.status.path, observation])
    );
    for (const change of changes) {
      const pending = this.pending.get(change.path);
      if (pending?.observed !== change.observed) continue;
      const observation = observationByPath.get(change.path);
      if (!observation) {
        this.baseline.set(change.path, change.observed);
        this.pending.delete(change.path);
        continue;
      }
      const status = observation.status;
      const acknowledged: MailboxStatus = {
        ...change.observed,
        path: change.path,
        uidValidity: status.uidValidity,
        uidNext: status.uidNext
      };
      if (observation.reconcileComplete) {
        acknowledged.exists = status.exists;
        acknowledged.messages = status.messages;
        this.unverifiableReconcilePaths.delete(change.path);
      } else {
        this.unverifiableReconcilePaths.add(change.path);
      }
      const hasComparableFlagStatus = status.highestModseq !== undefined
        || status.unseen !== undefined;
      if (observation.flagScanComplete && hasComparableFlagStatus) {
        if (status.unseen !== undefined) acknowledged.unseen = status.unseen;
        if (status.highestModseq !== undefined) {
          acknowledged.highestModseq = status.highestModseq;
        }
        this.unverifiedFlagStatusPaths.delete(change.path);
        if (status.highestModseq !== undefined) {
          this.unverifiableEventFlagPaths.delete(change.path);
        }
      } else {
        this.unverifiedFlagStatusPaths.add(change.path);
      }
      this.baseline.set(change.path, acknowledged);
      this.pending.delete(change.path);
    }
  }

  markAuthoritativelyProbed(status: MailboxStatus, change: MailboxChange | null): void {
    if (change) return;
    if (status.highestModseq !== undefined || status.unseen !== undefined) {
      this.unverifiedFlagStatusPaths.delete(status.path);
    }
    if (status.highestModseq !== undefined) {
      this.unverifiableEventFlagPaths.delete(status.path);
    }
  }

  takeUnverifiableChange(): MailboxChange | null {
    const path = this.unverifiableReconcilePaths.values().next().value
      ?? this.unverifiableEventFlagPaths.values().next().value
      ?? this.unverifiedFlagStatusPaths.values().next().value;
    if (typeof path !== "string") return null;
    const forceReconcile = this.unverifiableReconcilePaths.delete(path);
    const forceFlagScan = this.unverifiableEventFlagPaths.delete(path)
      || this.unverifiedFlagStatusPaths.delete(path);
    return this.signal(path, forceReconcile, forceFlagScan);
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

function notifySignal(value: unknown): ImapNotifySignal | null {
  if (!value || typeof value !== "object") return null;
  const signal = value as Partial<ImapNotifySignal>;
  if (!Number.isSafeInteger(signal.sequence) || Number(signal.sequence) <= 0) return null;
  if (!(signal.receivedAt instanceof Date) || !Number.isFinite(signal.receivedAt.getTime())) return null;
  if (typeof signal.monotonicReceivedAtMs !== "number"
    || !Number.isFinite(signal.monotonicReceivedAtMs)
    || typeof signal.eventType !== "string"
    || !NOTIFY_EVENT_TYPES.has(signal.eventType as ImapNotifySignal["eventType"])
    || typeof signal.connectionState !== "string"
    || typeof signal.activeCommand !== "string") return null;
  return {
    sequence: Number(signal.sequence),
    receivedAt: signal.receivedAt,
    monotonicReceivedAtMs: signal.monotonicReceivedAtMs,
    eventType: signal.eventType,
    connectionState: signal.connectionState,
    activeCommand: signal.activeCommand
  } as ImapNotifySignal;
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
  private readonly notifyConfigured: boolean;
  private notifyEnabled: boolean;
  private notifyArmed = false;
  private notifyGeneration = 0;
  private notifyPathsKey = "";
  private reconnectAfterNotifyOverflow = false;
  private deferredNotifyWake = false;
  private deferredNotifySignal: { folderPath: string; signal: ImapNotifySignal } | null = null;
  private deferredEventWake: Pick<InboxIdleWake, "kind" | "folderPath" | "notifySignal"> | null = null;
  private pendingOverflowSignal: ImapNotifySignal | null = null;
  private queuedWake: InboxIdleWake | null = null;
  private wakeDeliveryScheduled = false;
  private verificationPromise: Promise<InboxIdleWake | null> | null = null;
  private waitInProgress = false;
  private readonly lifecycleAbort = new AbortController();
  private readonly operationSignal: AbortSignal;
  private closed = false;

  constructor(
    readonly accountId: string,
    readonly connectedAt: Date,
    private readonly client: InboxIdleClient,
    config: AppConfig,
    private readonly folderStatusesFactory: () => Promise<InitialFolderStatus[]>,
    private readonly changeFeed: SessionMailboxChangeFeed,
    private readonly probeBatchSize: number,
    private readonly statusIntervalMs: number,
    private readonly onNotifyTraceObserved?: (trace: InboxIdleNotifyTrace) => void,
    private readonly signal?: AbortSignal,
    now: () => Date = () => new Date()
  ) {
    this.now = now;
    this.operationSignal = signal
      ? AbortSignal.any([signal, this.lifecycleAbort.signal])
      : this.lifecycleAbort.signal;
    this.listStatusEnabled = config.IMAP_LIST_STATUS_ENABLED
      && (client.capabilities.has("LIST-STATUS") || isRev2Active(client))
      && typeof client.list === "function";
    this.notifyConfigured = config.IMAP_NOTIFY_ENABLED;
    this.notifyEnabled = this.notifyConfigured
      && client.capabilities.has("NOTIFY")
      && typeof client.notify === "function";
    this.syncClient = new ThrottledImapClient(
      client as unknown as ImapFlow,
      config.IMAP_MAX_COMMANDS_PER_MINUTE,
      config.IMAP_COMMAND_TIMEOUT_MS,
      this.operationSignal,
      changeFeed
    );
    this.client.on("exists", this.onExists);
    this.client.on("expunge", this.onExpunge);
    this.client.on("flags", this.onFlags);
    this.client.on("notifyResponse", this.onNotifyResponse);
    this.client.on("status", this.onStatus);
    this.client.on("notificationOverflow", this.onNotificationOverflow);
    this.client.on("close", this.onClose);
  }

  private folderPaths: string[] = [];

  get folderProbeStrategy(): "notify" | "list_status" | "status" {
    if (this.notifyEnabled) return "notify";
    return this.listStatusEnabled ? "list_status" : "status";
  }

  get folderVerificationStrategy(): "list_status" | "status" {
    return this.listStatusEnabled ? "list_status" : "status";
  }

  private traceNotify(trace: InboxIdleNotifyTraceDetail): void {
    try {
      this.onNotifyTraceObserved?.({
        ...trace,
        observedAt: new Date(),
        monotonicObservedAtMs: performance.now(),
        notifyArmed: this.notifyArmed,
        notifyGeneration: this.notifyGeneration
      } as InboxIdleNotifyTrace);
    } catch {
      // Observation must never affect mailbox synchronization.
    }
  }

  private setNotifyState(
    armed: boolean,
    reason: Extract<InboxIdleNotifyTrace, { stage: "notify_state" }>["reason"]
  ): void {
    if (armed) this.notifyGeneration += 1;
    this.notifyArmed = armed;
    this.traceNotify({ stage: "notify_state", reason });
  }

  private async refreshFolderPaths(seed = false): Promise<void> {
    const signal = this.operationSignal;
    signal.throwIfAborted();
    const folders = await new Promise<InitialFolderStatus[]>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void this.folderStatusesFactory().then(
        (value) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
    if (seed) this.changeFeed.seed(folders);
    const paths = [...new Set(folders.map((folder) => folder.path))]
      .filter((path) => path.toLowerCase() !== "inbox");
    if (paths.length > 0 && typeof this.client.status !== "function") {
      throw new Error("IMAP STATUS is required when tracked folders are configured");
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
        this.setNotifyState(false, "unsupported");
        return [];
      }
      this.notifyPathsKey = pathsKey;
      this.setNotifyState(true, "armed");
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
      this.setNotifyState(false, "rejected");
      return [];
    }
  }

  async initialize(): Promise<void> {
    await this.refreshFolderPaths(true);
    if (!this.notifyEnabled) {
      this.setNotifyState(false, this.notifyConfigured ? "unsupported" : "disabled");
    }
    const baseline: MailboxStatus[] = await this.armNotify();
    const notifySeen = new Set(
      baseline.filter(isCompleteStatus).map((status) => status.path)
    );
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
    const seen = new Set(baseline.filter(isCompleteStatus).map((status) => status.path));
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
    for (const status of baseline) this.changeFeed.observe(status);
    this.changeFeed.finishInitialization();
  }

  private async listStatusSnapshots(
    paths = this.folderPaths,
    options: { allowWildcardFallback?: boolean } = {}
  ): Promise<MailboxStatus[]> {
    // LIST mailbox patterns have no escape for their `*` and `%` wildcards.
    // An exact probe is therefore impossible for these otherwise legal names.
    // Keep the whole session on bounded STATUS instead of broadening the query.
    if (paths.some((path) => /[*%]/.test(path))) {
      throw new Error("Tracked mailbox name cannot be represented as an exact LIST pattern");
    }
    const tracked = new Set(paths);
    const statuses = await this.syncClient.listWithStatus!(STATUS_QUERY, paths);
    if (this.listStatusWasRejected()) {
      throw new Error("IMAP server rejected LIST-STATUS");
    }
    let trackedStatuses = statuses.filter((status) => tracked.has(status.path));
    if (trackedStatuses.some((status) => !isCompleteStatus(status))) {
      throw new Error("IMAP server returned incomplete LIST-STATUS data");
    }
    // Some otherwise capable servers accept LIST-EXTENDED pattern lists but
    // return only the first match. Retry once with the standard wildcard form,
    // then filter the result back to the bounded tracked set. A partial or
    // malformed wildcard response still latches the existing STATUS fallback.
    if (options.allowWildcardFallback !== false
      && new Set(trackedStatuses.map((status) => status.path)).size !== tracked.size) {
      const wildcardStatuses = await this.syncClient.listWithStatus!(STATUS_QUERY, ["*"]);
      if (this.listStatusWasRejected()) {
        throw new Error("IMAP server rejected LIST-STATUS");
      }
      trackedStatuses = wildcardStatuses.filter((status) => tracked.has(status.path));
      if (trackedStatuses.some((status) => !isCompleteStatus(status))) {
        throw new Error("IMAP server returned incomplete LIST-STATUS data");
      }
    }
    return trackedStatuses;
  }

  private listStatusWasRejected(): boolean {
    return this.client.skipListStatusArgs === true;
  }

  private probeWasInterrupted(error: unknown): boolean {
    return this.closed
      || this.operationSignal.aborted
      || (error instanceof DOMException && error.name === "AbortError")
      || (error instanceof Error && (
        error.name === "AbortError"
        || error.message.startsWith("IMAP_COMMAND_TIMEOUT_MS exceeded")
      ))
      || this.client.usable === false;
  }

  private statusProbePaths(): string[] {
    const count = Math.min(this.probeBatchSize, this.folderPaths.length);
    return Array.from(
      { length: count },
      (_, index) => this.folderPaths[(this.probeCursor + index) % this.folderPaths.length]
    );
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
    const paths = this.statusProbePaths();
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

  verifyMailboxChanges(): Promise<InboxIdleWake | null> {
    if (this.closed) return Promise.reject(new Error("Inbox IDLE session is closed"));
    if (this.waitInProgress || this.waiter || this.acceptingEvents) {
      return Promise.reject(new Error("Mailbox verification cannot run during IDLE wait"));
    }
    if (this.verificationPromise) return this.verificationPromise;
    const verification = this.runMailboxVerification();
    this.verificationPromise = verification;
    void verification.finally(() => {
      if (this.verificationPromise === verification) this.verificationPromise = null;
    }).catch(() => undefined);
    return verification;
  }

  private async runMailboxVerification(): Promise<InboxIdleWake | null> {
    await this.refreshFolderPaths();
    const listStatusPaths = ["INBOX", ...this.folderPaths];
    let statuses: MailboxStatus[] = [];
    if (this.listStatusEnabled) {
      try {
        // Verification runs after every wake-driven sync. Do not use the
        // compatibility wildcard retry here: it can enumerate the provider's
        // entire mailbox tree on every delivery. A partial exact response
        // instead latches the bounded STATUS fallback below.
        statuses = await this.listStatusSnapshots(listStatusPaths, {
          allowWildcardFallback: false
        });
        if (new Set(statuses.map((status) => status.path)).size !== listStatusPaths.length) {
          this.listStatusEnabled = false;
          statuses = [];
        }
      } catch (error) {
        if (this.probeWasInterrupted(error)) throw error;
        this.listStatusEnabled = false;
      }
    }
    if (!this.listStatusEnabled) {
      const folderPaths = this.statusProbePaths();
      const paths = [
        "INBOX",
        ...folderPaths
      ];
      if (this.folderPaths.length > 0) {
        this.probeCursor = (this.probeCursor + folderPaths.length) % this.folderPaths.length;
      }
      for (const path of paths) {
        try {
          const status = await this.syncClient.status!(path, STATUS_QUERY);
          if (status.path !== path || !isCompleteStatus(status)) {
            throw new Error("IMAP server returned incomplete STATUS data");
          }
          statuses.push(status);
        } catch (error) {
          if (this.probeWasInterrupted(error)) throw error;
          this.changeFeed.signal(path, true, true);
        }
      }
    }
    for (const status of statuses) {
      const observedChange = this.changeFeed.observe(status);
      this.changeFeed.markAuthoritativelyProbed(status, observedChange);
    }
    const change = this.changeFeed.takeUnverifiableChange()
      ?? this.changeFeed.peek(1)[0];
    return change
      ? {
          kind: change.forceReconcile ? "exists" : "flags",
          accountId: this.accountId,
          folderPath: change.path,
          observedAt: this.now()
        }
      : null;
  }

  close(): void {
    if (this.closed) return;
    if (this.notifyArmed) this.setNotifyState(false, "closed");
    this.closed = true;
    this.lifecycleAbort.abort(new Error("Inbox IDLE session closed"));
    this.acceptingEvents = false;
    if (this.queuedWake) this.traceHandoff(this.queuedWake, "dropped", "session_closed");
    this.queuedWake = null;
    this.detach();
    this.client.close();
  }

  private detach(): void {
    this.client.removeListener("exists", this.onExists);
    this.client.removeListener("expunge", this.onExpunge);
    this.client.removeListener("flags", this.onFlags);
    this.client.removeListener("notifyResponse", this.onNotifyResponse);
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

  private traceEventCreated(signal: ImapNotifySignal | null, folderPath: string): void {
    if (!signal) return;
    this.traceNotify({ stage: "imapflow_event_created", signal, folderPath });
  }

  private traceHandoff(
    wake: Pick<InboxIdleWake, "notifySignal" | "folderPath">,
    result: Extract<InboxIdleNotifyTrace, { stage: "handoff" }>["result"],
    reason: Extract<InboxIdleNotifyTrace, { stage: "handoff" }>["reason"]
  ): void {
    if (!wake.notifySignal) return;
    this.traceNotify({
      stage: "handoff",
      signal: wake.notifySignal,
      folderPath: wake.folderPath,
      result,
      reason
    });
  }

  private wake(
    kind: InboxIdleWakeKind,
    data: {
      path?: unknown;
      count?: unknown;
      prevCount?: unknown;
      seq?: unknown;
      uid?: unknown;
      modseq?: unknown;
      notifySignal?: unknown;
    }
  ): void {
    const folderPath = typeof data.path === "string" ? data.path : "INBOX";
    const signal = notifySignal(data.notifySignal);
    this.traceEventCreated(signal, folderPath);
    if (this.changeFeed.isReplaying(folderPath)) {
      if (signal) this.traceHandoff({ folderPath, notifySignal: signal }, "ignored", "replay_in_progress");
      return;
    }
    if (!this.acceptingEvents) {
      const tracked = folderPath.toLowerCase() === "inbox" || this.folderPaths.includes(folderPath);
      if (!this.closed && tracked) {
        this.changeFeed.signalEvent(folderPath, kind, data);
        const previous = this.deferredEventWake;
        if (!previous || WAKE_PRIORITY[kind] >= WAKE_PRIORITY[previous.kind]) {
          if (previous) this.traceHandoff(previous, "coalesced", "deferred_replaced");
          this.deferredEventWake = {
            kind,
            folderPath,
            ...(signal ? { notifySignal: signal } : {})
          };
        } else {
          if (signal) {
            this.traceHandoff({ folderPath, notifySignal: signal }, "coalesced", "lower_priority");
          }
        }
      } else if (signal) {
        this.traceHandoff(
          { folderPath, notifySignal: signal },
          this.closed ? "dropped" : "ignored",
          this.closed ? "session_closed" : "untracked_folder"
        );
      }
      return;
    }
    this.changeFeed.signalEvent(folderPath, kind, data);
    const wake: InboxIdleWake = {
      kind,
      accountId: this.accountId,
      folderPath,
      observedAt: this.now(),
      ...(typeof data.count === "number" ? { count: data.count } : {}),
      ...(typeof data.prevCount === "number" ? { previousCount: data.prevCount } : {}),
      ...(typeof data.seq === "number" ? { sequence: data.seq } : {}),
      ...(typeof data.uid === "number" ? { uid: data.uid } : {}),
      ...(signal ? { notifySignal: signal } : {})
    };
    this.enqueueWake(wake);
  }

  private enqueueWake(wake: InboxIdleWake): void {
    if (!this.queuedWake || WAKE_PRIORITY[wake.kind] >= WAKE_PRIORITY[this.queuedWake.kind]) {
      if (this.queuedWake) this.traceHandoff(this.queuedWake, "coalesced", "superseded");
      this.queuedWake = wake;
    } else {
      this.traceHandoff(wake, "coalesced", "lower_priority");
    }
    if (this.wakeDeliveryScheduled) return;
    this.wakeDeliveryScheduled = true;
    queueMicrotask(() => {
      this.wakeDeliveryScheduled = false;
      const queued = this.queuedWake;
      this.queuedWake = null;
      if (!queued) return;
      if (!this.acceptingEvents || this.closed) {
        this.traceHandoff(queued, "dropped", this.closed ? "session_closed" : "not_accepting_events");
        return;
      }
      this.traceHandoff(queued, "emitted", "wake_delivered");
      this.deliver({ status: "wake", wake: queued });
    });
  }

  private readonly onStatus = (data: unknown) => {
    if (!data || typeof data !== "object") return;
    const status = data as Partial<MailboxStatus> & Pick<MailboxStatus, "path">;
    const signal = notifySignal(status.notifySignal);
    if (typeof status.path !== "string") return;
    this.traceEventCreated(signal, status.path);
    const ignored = (
      reason: Extract<InboxIdleNotifyTrace, { stage: "handoff" }>["reason"]
    ) => {
      if (!signal) return;
      this.traceHandoff({ folderPath: status.path, notifySignal: signal }, "ignored", reason);
    };
    if (!this.notifyEnabled) {
      ignored("notify_disabled");
      return;
    }
    if (status.path.toLowerCase() === "inbox") {
      ignored("inbox_status");
      return;
    }
    if (!this.folderPaths.includes(status.path)) {
      ignored("untracked_folder");
      return;
    }
    const { notifySignal: _notifySignal, ...mailboxStatus } = status;
    const change = this.changeFeed.observe(mailboxStatus as MailboxStatus);
    if (!change) {
      ignored("unchanged");
      return;
    }
    if (!this.acceptingEvents) {
      this.deferredNotifyWake = true;
      if (signal) {
        if (this.deferredNotifySignal) this.traceHandoff({
          folderPath: this.deferredNotifySignal.folderPath,
          notifySignal: this.deferredNotifySignal.signal
        }, "coalesced", "deferred_replaced");
        this.deferredNotifySignal = { folderPath: change.path, signal };
      }
      return;
    }
    this.enqueueWake({
      kind: change.forceReconcile ? "exists" : "flags",
      accountId: this.accountId,
      folderPath: change.path,
      observedAt: this.now(),
      ...(signal ? { notifySignal: signal } : {})
    });
  };

  private readonly onNotifyResponse = (data: unknown) => {
    const signal = notifySignal(data);
    if (!signal) return;
    if (signal.eventType === "NOTIFICATIONOVERFLOW") this.pendingOverflowSignal = signal;
    this.traceNotify({ stage: "response_received", signal });
  };

  private readonly onNotificationOverflow = () => {
    const signal = this.pendingOverflowSignal;
    this.pendingOverflowSignal = null;
    if (!this.notifyEnabled) {
      if (signal) this.traceHandoff({ folderPath: "INBOX", notifySignal: signal },
        "ignored", "notify_disabled");
      return;
    }
    this.notifyEnabled = false;
    this.notifyPathsKey = "";
    this.setNotifyState(false, "overflow");
    this.reconnectAfterNotifyOverflow = true;
    this.changeFeed.signal("INBOX", true, true);
    for (const path of this.folderPaths) {
      this.changeFeed.signal(path, true, true);
    }
    const change = this.changeFeed.peek(1)[0];
    if (!change) {
      if (signal) this.traceHandoff({ folderPath: "INBOX", notifySignal: signal },
        "ignored", "no_dirty_folder");
      return;
    }
    if (!this.acceptingEvents) {
      this.deferredNotifyWake = true;
      if (signal) this.deferredNotifySignal = { folderPath: change.path, signal };
      return;
    }
    this.enqueueWake({
      kind: "expunge",
      accountId: this.accountId,
      folderPath: change.path,
      observedAt: this.now(),
      ...(signal ? { notifySignal: signal } : {})
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
    if (this.notifyArmed) this.setNotifyState(false, "closed");
    this.closed = true;
    if (this.queuedWake) this.traceHandoff(this.queuedWake, "dropped", "connection_closed");
    this.queuedWake = null;
    this.detach();
    this.deliver({ status: "disconnected" });
    this.lifecycleAbort.abort(new Error("Inbox IDLE connection closed"));
  };

  private takeDeferredWake(): InboxIdleWaitResult | null {
    if (this.reconnectAfterNotifyOverflow) {
      const overflowChange = this.changeFeed.peek(1)[0];
      if (overflowChange) {
        this.deferredNotifyWake = false;
        const signal = this.deferredNotifySignal?.folderPath === overflowChange.path
          ? this.deferredNotifySignal.signal
          : null;
        this.deferredNotifySignal = null;
        const wake: InboxIdleWake = {
          kind: overflowChange.forceReconcile ? "exists" : "flags",
          accountId: this.accountId,
          folderPath: overflowChange.path,
          observedAt: this.now(),
          ...(signal ? { notifySignal: signal } : {})
        };
        this.traceHandoff(wake, "emitted", "deferred_wake_delivered");
        return {
          status: "wake",
          wake
        };
      }
      this.close();
      return { status: "disconnected" };
    }
    const pendingChange = this.deferredNotifyWake ? this.changeFeed.peek(1)[0] : undefined;
    if (pendingChange) {
      this.deferredNotifyWake = false;
      const deferredSignal = this.deferredNotifySignal;
      const signal = deferredSignal?.folderPath === pendingChange.path
        ? deferredSignal.signal
        : null;
      this.deferredNotifySignal = null;
      if (deferredSignal && !signal) this.traceHandoff({
        folderPath: deferredSignal.folderPath,
        notifySignal: deferredSignal.signal
      }, "coalesced", "covered_by_reconciliation");
      const wake: InboxIdleWake = {
        kind: pendingChange.forceReconcile ? "exists" : "flags",
        accountId: this.accountId,
        folderPath: pendingChange.path,
        observedAt: this.now(),
        ...(signal ? { notifySignal: signal } : {})
      };
      this.traceHandoff(wake, "emitted", "deferred_wake_delivered");
      return {
        status: "wake",
        wake
      };
    }
    if (this.deferredNotifyWake) {
      this.deferredNotifyWake = false;
      const covered = this.deferredNotifySignal;
      this.deferredNotifySignal = null;
      if (covered) this.traceHandoff({
        folderPath: covered.folderPath,
        notifySignal: covered.signal
      }, "coalesced", "covered_by_reconciliation");
    }
    const deferredEvent = this.deferredEventWake;
    if (!deferredEvent) return null;
    this.deferredEventWake = null;
    const pendingChanges = this.changeFeed.peek();
    const eventChange = pendingChanges.find(
      (candidate) => candidate.path === deferredEvent.folderPath
    ) ?? pendingChanges[0];
    if (!eventChange) {
      this.traceHandoff(deferredEvent, "coalesced", "covered_by_reconciliation");
      return null;
    }
    const sameEvent = deferredEvent.folderPath === eventChange.path;
    if (!sameEvent) {
      this.traceHandoff(deferredEvent, "coalesced", "covered_by_reconciliation");
    }
    const wake: InboxIdleWake = {
      kind: sameEvent
        ? deferredEvent.kind
        : eventChange.forceReconcile ? "exists" : "flags",
      accountId: this.accountId,
      folderPath: eventChange.path,
      observedAt: this.now(),
      ...(sameEvent && deferredEvent.notifySignal
        ? { notifySignal: deferredEvent.notifySignal }
        : {})
    };
    this.traceHandoff(wake, "emitted", "deferred_wake_delivered");
    return {
      status: "wake",
      wake
    };
  }

  async wait(
    options: { signal?: AbortSignal; now?: () => Date } = {}
  ): Promise<InboxIdleWaitResult> {
    options.signal?.throwIfAborted();
    if (this.waitInProgress) {
      throw new Error("Inbox IDLE wait is already in progress");
    }
    if (this.verificationPromise) {
      throw new Error("Inbox IDLE wait cannot start during mailbox verification");
    }
    const queued = this.pending.shift();
    if (queued) return queued;
    if (this.closed) return { status: "disconnected" };
    // RFC 5465 says NOTIFICATIONOVERFLOW behaves as NOTIFY NONE, including
    // suppressing the selected-mailbox events used by Inbox IDLE. Drain every
    // bounded catch-up batch before replacing this connection.
    const deferred = this.takeDeferredWake();
    if (deferred) return deferred;
    const waitSignal = options.signal
      ? AbortSignal.any([options.signal, this.operationSignal])
      : this.operationSignal;
    waitSignal.throwIfAborted();
    this.waitInProgress = true;
    try {
      return await this.runWait({ ...options, signal: waitSignal });
    } finally {
      this.waitInProgress = false;
    }
  }

  private async runWait(
    options: { signal?: AbortSignal; now?: () => Date }
  ): Promise<InboxIdleWaitResult> {
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
      if (this.client.mailbox && typeof this.client.mailbox === "object") {
        this.changeFeed.observe({
          ...this.client.mailbox,
          path: "INBOX",
          messages: this.client.mailbox.messages ?? this.client.mailbox.exists
        });
      }
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
  const suppliedStatuses = new Map(
    (options.initialFolderStatuses ?? []).map((status) => [status.path, {
      ...status,
      reconnectCursor: true
    }])
  );
  const folderStatusesFactory = options.folderPathsFactory
    ? async () => (await options.folderPathsFactory!()).map(
        (path) => suppliedStatuses.get(path) ?? { path }
      )
    : options.clientFactory
      ? async () => [...suppliedStatuses.values()]
      : async () => (await repository.getTrackedFoldersForWake(account.id)).map(persistedFolderStatus);
  const changeFeed = new SessionMailboxChangeFeed(client.capabilities.has("QRESYNC"));
  const session = new ReusableInboxIdleSession(
    account.id,
    connectedAt,
    client,
    config,
    folderStatusesFactory,
    changeFeed,
    config.MAX_PRIORITY_FOLDERS_PER_CYCLE + config.MAX_RR_FOLDERS_PER_CYCLE,
    config.IMAP_FOLDER_STATUS_INTERVAL_MS,
    options.onNotifyTrace,
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
