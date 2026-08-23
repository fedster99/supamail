import type { ExpungeEvent, FlagsEvent, ImapFlow } from "imapflow";
import type { AppConfig } from "./config.js";
import type { PgPool } from "./db.js";
import { connectImap } from "./imap-connect.js";
import {
  extractAttachmentMetadata,
  normalizeMessageId,
  parseHeaders,
  parseRawMime,
  parseRawMimeStream,
  selectBodyTextPart
} from "./mime.js";
import {
  MAX_SYNC_ATTACHMENTS_PER_FETCH,
  PARSED_BODY_BATCH_MAX_MESSAGES,
  PARSED_BODY_BATCH_MAX_SOURCE_BYTES,
  PARSED_BODY_BATCH_MAX_TOTAL_SOURCE_BYTES,
  MAX_SYNC_FLAG_FETCH_BYTES,
  MAX_SYNC_FLAGS_PER_FETCH,
  MAX_SYNC_METADATA_FETCH_BYTES,
  MAX_SYNC_BATCH_SIZE,
  flagSnapshotFootprint,
  metadataMessageFootprint
} from "./sync-limits.js";
import { ImapThrottle } from "./throttle.js";
import type {
  ImapAccount,
  ImapMessage,
  MessageBodyInput,
  MessageFlagSnapshot,
  MessageMetadata
} from "./types.js";

const MAX_QRESYNC_VANISHED_UIDS = 10_000;

export type ImapNotifyEventType =
  | "EXISTS"
  | "EXPUNGE"
  | "FETCH_FLAGS"
  | "STATUS"
  | "NOTIFICATIONOVERFLOW";

export interface ImapNotifySignal {
  sequence: number;
  receivedAt: Date;
  monotonicReceivedAtMs: number;
  eventType: ImapNotifyEventType;
  connectionState: string;
  activeCommand: string;
}

export interface MailboxStatus {
  path: string;
  uidValidity: bigint | number;
  uidNext?: number;
  exists?: number;
  messages?: number;
  unseen?: number;
  highestModseq?: bigint | number;
  notifySignal?: ImapNotifySignal;
}

export interface MailboxChange {
  path: string;
  forceReconcile: boolean;
  forceFlagScan: boolean;
  observed: MailboxStatus;
}

export interface MailboxChangeObservation {
  status: MailboxStatus;
  reconcileComplete: boolean;
  flagScanComplete: boolean;
}

export interface MailboxChangeFeed {
  peek(limit?: number): readonly MailboxChange[];
  acknowledge(changes: readonly MailboxChange[]): void;
  acknowledgeWithStatuses?(
    changes: readonly MailboxChange[],
    observations: readonly MailboxChangeObservation[]
  ): void;
  beginReplay?(path: string): void;
  endReplay?(path: string): void;
}

export interface MailboxLock {
  release(): void;
  qresync?: QresyncReplay;
}

export interface QresyncRequest {
  uidValidity: bigint;
  changedSince: bigint;
}

export interface QresyncReplay {
  accepted: boolean;
  complete: boolean;
  vanishedUids: number[];
  changedFlags: MessageFlagSnapshot[];
}

export interface MailboxListItem {
  path: string;
  delimiter?: string;
  specialUse?: string;
  flags?: Set<string>;
  status?: MailboxStatus | { error: unknown };
}

export interface FetchMessage {
  uid: number;
  flags?: Set<string>;
  internalDate?: Date;
  size?: number;
  envelope?: {
    messageId?: string;
    subject?: string;
    from?: Array<{ address?: string; name?: string }>;
    to?: Array<{ address?: string; name?: string }>;
    cc?: Array<{ address?: string; name?: string }>;
    bcc?: Array<{ address?: string; name?: string }>;
  };
  headers?: Buffer;
  bodyStructure?: unknown;
  emailId?: string;
  threadId?: string;
  source?: Buffer;
}

export interface DownloadResult {
  content?: AsyncIterable<Buffer | Uint8Array | string>;
}

export interface MirrorImapClient {
  mailbox: MailboxStatus | false | null;
  capabilities?: ReadonlyMap<string, boolean | number>;
  usable?: boolean;
  connect?(): Promise<void>;
  close?(): void;
  logout(): Promise<void>;
  list(): Promise<MailboxListItem[]>;
  listWithStatus?(
    query: Record<string, boolean>,
    mailboxPatterns: readonly string[]
  ): Promise<MailboxStatus[]>;
  status?(
    path: string,
    query: Record<string, boolean>
  ): Promise<MailboxStatus>;
  notify?(mailboxes: readonly string[]): Promise<MailboxStatus[] | false>;
  peekMailboxChanges?(limit?: number): readonly MailboxChange[];
  acknowledgeMailboxChanges?(changes: readonly MailboxChange[]): void;
  acknowledgeMailboxChangesWithStatuses?(
    changes: readonly MailboxChange[],
    observations: readonly MailboxChangeObservation[]
  ): void;
  getMailboxLock(path: string, options?: { qresync?: QresyncRequest }): Promise<MailboxLock>;
  fetch(
    range: string | number[] | Record<string, unknown>,
    query: Record<string, unknown>,
    options?: Record<string, unknown>
  ): AsyncIterable<FetchMessage>;
  fetchOne(
    range: string,
    query: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<FetchMessage | false | null>;
  download(range: string, part?: string, options?: Record<string, unknown>): Promise<DownloadResult>;
}

export class ThrottledImapClient implements MirrorImapClient {
  private readonly throttle: ImapThrottle;
  private qresyncDisabled = false;

  constructor(
    private readonly client: ImapFlow,
    maxCommandsPerMinute: number,
    private readonly commandTimeoutMs: number,
    private readonly signal?: AbortSignal,
    private readonly mailboxChangeFeed?: MailboxChangeFeed
  ) {
    this.throttle = new ImapThrottle(maxCommandsPerMinute);
  }

  get mailbox(): MailboxStatus | false | null {
    return this.client.mailbox as MailboxStatus | false | null;
  }

  get usable(): boolean {
    return this.client.usable;
  }

  get capabilities(): ReadonlyMap<string, boolean | number> {
    return this.client.capabilities;
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async logout(): Promise<void> {
    await this.withCommandTimeout("logout", () => this.client.logout());
  }

  close(): void {
    this.client.close();
  }

  async list(): Promise<MailboxListItem[]> {
    await this.throttle.acquire(this.signal);
    return await this.withCommandTimeout("list", async () => (await this.client.list()) as MailboxListItem[]);
  }

  async listWithStatus(
    query: Record<string, boolean>,
    mailboxPatterns: readonly string[]
  ): Promise<MailboxStatus[]> {
    await this.throttle.acquire(this.signal);
    const folders = await this.withCommandTimeout(
      "list status",
      async () => await this.client.list({
        statusQuery: query,
        statusFallback: false,
        mailboxPatterns: [...mailboxPatterns],
        statusOnly: true,
        returnOptionFallback: false,
        cache: false
      }) as MailboxListItem[]
    );
    return folders.flatMap((folder) => {
      if (!folder.status || "error" in folder.status) return [];
      return [{ ...folder.status, path: folder.path }];
    });
  }

  async status(
    path: string,
    query: Record<string, boolean>
  ): Promise<MailboxStatus> {
    await this.throttle.acquire(this.signal);
    const status = await this.withCommandTimeout(
      "status",
      () => this.client.status(path, query as never)
    );
    if (!status) throw new Error("IMAP STATUS returned no mailbox state");
    return status as MailboxStatus;
  }

  async notify(mailboxes: readonly string[]): Promise<MailboxStatus[] | false> {
    await this.throttle.acquire(this.signal);
    return await this.withCommandTimeout(
      "notify",
      async () => await this.client.notify([...mailboxes]) as MailboxStatus[] | false
    );
  }

  peekMailboxChanges(limit?: number): readonly MailboxChange[] {
    return this.mailboxChangeFeed?.peek(limit) ?? [];
  }

  acknowledgeMailboxChanges(changes: readonly MailboxChange[]): void {
    this.mailboxChangeFeed?.acknowledge(changes);
  }

  acknowledgeMailboxChangesWithStatuses(
    changes: readonly MailboxChange[],
    observations: readonly MailboxChangeObservation[]
  ): void {
    if (this.mailboxChangeFeed?.acknowledgeWithStatuses) {
      this.mailboxChangeFeed.acknowledgeWithStatuses(changes, observations);
      return;
    }
    this.mailboxChangeFeed?.acknowledge(changes);
  }

  async getMailboxLock(
    path: string,
    options: { qresync?: QresyncRequest } = {}
  ): Promise<MailboxLock> {
    await this.throttle.acquire(this.signal);
    const request = options.qresync;
    if (!request || this.qresyncDisabled) {
      return await this.withCommandTimeout("getMailboxLock", () => this.client.getMailboxLock(path));
    }

    const vanishedUids = new Set<number>();
    const changedFlags = new Map<number, MessageFlagSnapshot>();
    let retainedFlagBytes = 2;
    let retainedFlags = 0;
    let complete = true;

    const invalidateReplay = () => {
      complete = false;
      vanishedUids.clear();
      changedFlags.clear();
      retainedFlagBytes = 2;
      retainedFlags = 0;
    };
    const onExpunge = (event: ExpungeEvent) => {
      if (event.path !== path || !complete) return;
      if (!event.vanished || !Number.isSafeInteger(event.uid) || event.uid! <= 0) {
        invalidateReplay();
        return;
      }
      if (vanishedUids.size >= MAX_QRESYNC_VANISHED_UIDS && !vanishedUids.has(event.uid!)) {
        invalidateReplay();
        return;
      }
      vanishedUids.add(event.uid!);
    };
    const onFlags = (event: FlagsEvent) => {
      if (event.path !== path || !complete) return;
      if (!Number.isSafeInteger(event.uid) || event.uid! <= 0 || !(event.flags instanceof Set)) {
        invalidateReplay();
        return;
      }
      const snapshot = { uid: event.uid!, flags: [...event.flags] };
      const footprint = flagSnapshotFootprint(snapshot);
      const previous = changedFlags.get(snapshot.uid);
      if (previous) {
        const previousFootprint = flagSnapshotFootprint(previous);
        retainedFlagBytes -= previousFootprint.bytes;
        retainedFlags -= previousFootprint.flags;
      }
      retainedFlagBytes += footprint.bytes;
      retainedFlags += footprint.flags;
      if (retainedFlagBytes > MAX_SYNC_FLAG_FETCH_BYTES || retainedFlags > MAX_SYNC_FLAGS_PER_FETCH) {
        invalidateReplay();
        return;
      }
      changedFlags.set(snapshot.uid, snapshot);
    };

    this.mailboxChangeFeed?.beginReplay?.(path);
    this.client.on("expunge", onExpunge);
    this.client.on("flags", onFlags);
    try {
      let lock: MailboxLock;
      try {
        lock = await this.withCommandTimeout(
          "getMailboxLock QRESYNC",
          () => this.client.getMailboxLock(path, {
            uidValidity: request.uidValidity,
            changedSince: request.changedSince
          } as never)
        );
      } catch (error) {
        this.qresyncDisabled = true;
        throw error;
      }
      const mailbox = this.client.mailbox;
      let accepted = mailbox !== false
        && mailbox !== null
        && mailbox.qresync === true
        && BigInt(mailbox.uidValidity) === request.uidValidity
        && mailbox.highestModseq !== undefined;
      if (accepted && mailbox) {
        try {
          accepted = BigInt(mailbox.highestModseq!) >= request.changedSince;
        } catch {
          accepted = false;
        }
      }
      if (!accepted) this.qresyncDisabled = true;
      return {
        ...lock,
        qresync: {
          accepted,
          complete: accepted && complete,
          vanishedUids: accepted && complete ? [...vanishedUids].sort((a, b) => a - b) : [],
          changedFlags: accepted && complete
            ? [...changedFlags.values()].sort((a, b) => a.uid - b.uid)
            : []
        }
      };
    } finally {
      this.client.off("expunge", onExpunge);
      this.client.off("flags", onFlags);
      this.mailboxChangeFeed?.endReplay?.(path);
    }
  }

  async *fetch(
    range: string | number[] | Record<string, unknown>,
    query: Record<string, unknown>,
    options?: Record<string, unknown>
  ): AsyncIterable<FetchMessage> {
    await this.throttle.acquire(this.signal);
    const iterator = (this.client.fetch(
      range as never,
      query as never,
      options as never
    ) as AsyncIterable<FetchMessage>)[Symbol.asyncIterator]();

    let completed = false;
    try {
      while (true) {
        const item = await this.withCommandTimeout("fetch", () => iterator.next());
        if (item.done) {
          completed = true;
          break;
        }
        yield item.value;
      }
    } finally {
      if (!completed && iterator.return) {
        try {
          await this.withCommandTimeout("fetch cancel", () => iterator.return!());
        } catch {
          this.client.close();
        }
      }
    }
  }

  async fetchOne(
    range: string,
    query: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<FetchMessage | false | null> {
    await this.throttle.acquire(this.signal);
    return await this.withCommandTimeout(
      "fetchOne",
      async () => await this.client.fetchOne(range, query as never, options as never) as FetchMessage | false | null
    );
  }

  async download(range: string, part?: string, options?: Record<string, unknown>): Promise<DownloadResult> {
    await this.throttle.acquire(this.signal);
    return await this.withCommandTimeout(
      "download",
      async () => await this.client.download(range, part as never, options as never) as DownloadResult
    );
  }

  private async withCommandTimeout<T>(operation: string, run: () => Promise<T>): Promise<T> {
    this.signal?.throwIfAborted();
    let timeout: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        this.client.close();
        reject(new Error(`IMAP_COMMAND_TIMEOUT_MS exceeded during ${operation}`));
      }, this.commandTimeoutMs);
    });
    const abortPromise = new Promise<never>((_, reject) => {
      if (!this.signal) return;
      onAbort = () => {
        this.client.close();
        reject(this.signal!.reason instanceof Error
          ? this.signal!.reason
          : new DOMException(`IMAP ${operation} aborted`, "AbortError"));
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      return await Promise.race([run(), timeoutPromise, abortPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onAbort) this.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export async function createImapClient(
  pool: PgPool,
  config: AppConfig,
  account: ImapAccount,
  options: { signal?: AbortSignal } = {}
): Promise<MirrorImapClient> {
  // Socket + SSRF guard + decrypt + the close-on-connect-error guard come from the
  // one shared connect prelude (imap-connect.ts); this adapter only adds the
  // read-only throttled verb surface on top (ADR 0017/0022).
  const rawClient = await connectImap(pool, config, account, { ...options, purpose: "sync" });
  return new ThrottledImapClient(
    rawClient,
    config.IMAP_MAX_COMMANDS_PER_MINUTE,
    config.IMAP_COMMAND_TIMEOUT_MS,
    options.signal
  );
}

function firstAddress(addresses: Array<{ address?: string; name?: string }> | undefined): {
  email: string | null;
  name: string | null;
} {
  const first = addresses?.[0];
  return {
    email: first?.address ?? null,
    name: first?.name ?? null
  };
}

function addressList(addresses: Array<{ address?: string; name?: string }> | undefined): {
  emails: string[];
  names: (string | null)[];
} {
  const emails: string[] = [];
  const names: (string | null)[] = [];

  for (const address of addresses ?? []) {
    if (!address.address) continue;
    emails.push(address.address);
    names.push(address.name ?? null);
  }

  return { emails, names };
}

export type ProviderObjectIdNamespace = "objectid" | "gmail";

type JsonMetadataValue =
  | null
  | boolean
  | number
  | string
  | JsonMetadataValue[]
  | { [key: string]: JsonMetadataValue };

function normalizeMimeMetadata(
  value: unknown,
  ancestors = new WeakSet<object>()
): JsonMetadataValue {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new Error("IMAP MIME metadata contains an invalid date");
    }
    return value.toISOString();
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("IMAP MIME metadata contains a non-finite number");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error("IMAP MIME metadata contains a non-JSON value");
  }
  if (ancestors.has(value)) {
    throw new Error("IMAP MIME metadata contains a cycle");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from(value, (item) => normalizeMimeMetadata(item, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("IMAP MIME metadata contains a non-JSON object");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("IMAP MIME metadata contains a symbol key");
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeMimeMetadata(item, ancestors)])
    );
  } finally {
    ancestors.delete(value);
  }
}

export function providerObjectIdNamespace(
  capabilities: ReadonlyMap<string, boolean | number> | undefined
): ProviderObjectIdNamespace | null {
  if (capabilities?.has("OBJECTID")) return "objectid";
  if (capabilities?.has("X-GM-EXT-1")) return "gmail";
  return null;
}

export function parseMessageMetadata(
  msg: FetchMessage,
  providerNamespace: ProviderObjectIdNamespace | null = null
): MessageMetadata {
  const headers = parseHeaders(msg.headers);
  const from = firstAddress(msg.envelope?.from);
  const to = addressList(msg.envelope?.to);
  const cc = addressList(msg.envelope?.cc);
  const bcc = addressList(msg.envelope?.bcc);
  const rfcMessageId = msg.envelope?.messageId ?? headers["message-id"] ?? null;

  return {
    uid: msg.uid,
    internalDate: msg.internalDate instanceof Date ? msg.internalDate : new Date(),
    sizeBytes: msg.size ?? 0,
    flags: [...(msg.flags ?? new Set<string>())],
    rfcMessageId,
    messageIdNormalized: normalizeMessageId(rfcMessageId),
    providerMessageId: msg.emailId ?? null,
    providerMessageIdNamespace: msg.emailId ? providerNamespace : null,
    providerThreadId: msg.threadId ?? null,
    providerThreadIdNamespace: msg.threadId ? providerNamespace : null,
    inReplyTo: headers["in-reply-to"] ?? null,
    referencesHeader: headers.references ?? null,
    subject: msg.envelope?.subject ?? null,
    fromEmail: from.email,
    fromName: from.name,
    toEmails: to.emails,
    toNames: to.names,
    ccEmails: cc.emails,
    ccNames: cc.names,
    bccEmails: bcc.emails,
    headersJson: headers,
    mimeStructure: normalizeMimeMetadata(msg.bodyStructure ?? null),
    attachments: extractAttachmentMetadata(msg.bodyStructure)
  };
}

export async function fetchMessageMetadata(
  client: MirrorImapClient,
  uids: number[],
  batchSize: number
): Promise<MessageMetadata[]> {
  const messages: MessageMetadata[] = [];
  const providerNamespace = providerObjectIdNamespace(client.capabilities);
  const requestedUids = [...new Set(uids)];
  let retainedBytes = 2;
  let retainedAttachments = 0;

  for (let i = 0; i < requestedUids.length; i += batchSize) {
    const batch = requestedUids.slice(i, i + batchSize);
    if (batch.length === 0) continue;
    const expected = new Set(batch);
    const returned = new Map<number, MessageMetadata>();

    for await (const msg of client.fetch(batch, {
      uid: true,
      flags: true,
      internalDate: true,
      size: true,
      envelope: true,
      bodyStructure: true,
      threadId: true,
      headers: [
        "message-id",
        "references",
        "in-reply-to",
        "auto-submitted",
        "x-auto-response-suppress",
        "list-unsubscribe",
        "list-id",
        "precedence",
        "reply-to",
        "thread-index",
        "thread-topic"
      ]
    }, { uid: true })) {
      // Ignore unsolicited UID-less, out-of-range, and flags-only FETCH responses.
      // A requested UID is complete only when the fundamental requested fields are
      // present; the completeness check below still fails closed if its real response
      // never arrives. Latest complete response wins if a provider repeats a UID.
      if (!Number.isInteger(msg.uid) || !expected.has(msg.uid)) continue;
      const hasRequestedMetadata = msg.flags !== undefined
        && msg.internalDate instanceof Date
        && typeof msg.size === "number"
        && Number.isSafeInteger(msg.size)
        && msg.size >= 0
        && msg.envelope !== undefined
        && msg.headers !== undefined
        && msg.bodyStructure !== undefined;
      if (!hasRequestedMetadata) continue;
      const parsed = parseMessageMetadata(msg, providerNamespace);
      const footprint = metadataMessageFootprint(parsed);
      const previous = returned.get(msg.uid);
      if (previous) {
        const previousFootprint = metadataMessageFootprint(previous);
        retainedBytes -= previousFootprint.bytes;
        retainedAttachments -= previousFootprint.attachments;
      }
      retainedBytes += footprint.bytes;
      retainedAttachments += footprint.attachments;
      if (retainedBytes > MAX_SYNC_METADATA_FETCH_BYTES
        || retainedAttachments > MAX_SYNC_ATTACHMENTS_PER_FETCH) {
        throw new Error("IMAP metadata fetch exceeded the aggregate memory budget");
      }
      returned.set(msg.uid, parsed);
    }

    const missing = batch.filter((uid) => !returned.has(uid));
    if (missing.length > 0) {
      throw new Error(
        `IMAP metadata fetch returned ${returned.size}/${expected.size} requested UIDs; missing ${missing
          .slice(0, 10)
          .join(",")}`
      );
    }
    messages.push(...batch.map((uid) => returned.get(uid)!));
  }

  return messages;
}

export class FlagFetchBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlagFetchBudgetExceededError";
  }
}

export async function fetchMessageFlags(
  client: MirrorImapClient,
  uids: number[],
  batchSize: number
): Promise<MessageFlagSnapshot[]> {
  const snapshots: MessageFlagSnapshot[] = [];
  const requestedUids = [...new Set(uids)];
  let retainedBytes = 2;
  let retainedFlags = 0;

  for (let i = 0; i < requestedUids.length; i += batchSize) {
    const batch = requestedUids.slice(i, i + batchSize);
    if (batch.length === 0) continue;
    const expected = new Set(batch);
    const returned = new Map<number, MessageFlagSnapshot>();
    const omittedFlags = new Set<number>();

    for await (const msg of client.fetch(batch, { uid: true, flags: true }, { uid: true })) {
      if (!Number.isInteger(msg.uid) || !expected.has(msg.uid)) continue;
      if (msg.flags === undefined) {
        omittedFlags.add(msg.uid);
        continue;
      }
      const snapshot = { uid: msg.uid, flags: [...msg.flags] };
      const footprint = flagSnapshotFootprint(snapshot);
      const previous = returned.get(msg.uid);
      if (previous) {
        const previousFootprint = flagSnapshotFootprint(previous);
        retainedBytes -= previousFootprint.bytes;
        retainedFlags -= previousFootprint.flags;
      }
      retainedBytes += footprint.bytes;
      retainedFlags += footprint.flags;
      if (retainedBytes > MAX_SYNC_FLAG_FETCH_BYTES || retainedFlags > MAX_SYNC_FLAGS_PER_FETCH) {
        throw new FlagFetchBudgetExceededError("IMAP flag fetch exceeded the aggregate memory budget");
      }
      returned.set(msg.uid, snapshot);
    }

    const missing = batch.filter((uid) => !returned.has(uid));
    if (missing.length > 0) {
      const omitted = missing.find((uid) => omittedFlags.has(uid));
      if (omitted !== undefined) {
        throw new Error(`IMAP flag fetch omitted FLAGS for requested UID ${omitted}`);
      }
      throw new Error(
        `IMAP flag fetch returned ${returned.size}/${expected.size} requested UIDs; missing ${missing
          .slice(0, 10)
          .join(",")}`
      );
    }
    snapshots.push(...batch.map((uid) => returned.get(uid)!));
  }

  return snapshots;
}

/** Fetch only flag rows whose CONDSTORE modification sequence advanced. */
export async function* iterateChangedMessageFlagBatches(
  client: MirrorImapClient,
  changedSince: bigint,
  batchSize = MAX_SYNC_BATCH_SIZE
): AsyncIterable<MessageFlagSnapshot[]> {
  let returned = new Map<number, MessageFlagSnapshot>();
  let retainedBytes = 2;
  let retainedFlags = 0;

  const takeBatch = () => {
    const batch = [...returned.values()];
    returned = new Map();
    retainedBytes = 2;
    retainedFlags = 0;
    return batch;
  };

  for await (const msg of client.fetch(
    "1:*",
    { uid: true, flags: true },
    { uid: true, changedSince }
  )) {
    if (!Number.isInteger(msg.uid)) continue;
    if (msg.flags === undefined) {
      throw new Error(`IMAP changed flag fetch omitted FLAGS for UID ${msg.uid}`);
    }
    const snapshot = { uid: msg.uid, flags: [...msg.flags] };
    const footprint = flagSnapshotFootprint(snapshot);
    const previous = returned.get(msg.uid);
    if (!previous && returned.size > 0
      && (retainedBytes + footprint.bytes > MAX_SYNC_FLAG_FETCH_BYTES
        || retainedFlags + footprint.flags > MAX_SYNC_FLAGS_PER_FETCH)) {
      yield takeBatch();
    }
    if (previous) {
      const previousFootprint = flagSnapshotFootprint(previous);
      retainedBytes -= previousFootprint.bytes;
      retainedFlags -= previousFootprint.flags;
    }
    retainedBytes += footprint.bytes;
    retainedFlags += footprint.flags;
    if (retainedBytes > MAX_SYNC_FLAG_FETCH_BYTES || retainedFlags > MAX_SYNC_FLAGS_PER_FETCH) {
      throw new FlagFetchBudgetExceededError("IMAP changed flag batch exceeded the memory budget");
    }
    returned.set(msg.uid, snapshot);
    if (returned.size >= batchSize) yield takeBatch();
  }

  if (returned.size > 0) yield takeBatch();
}

/** Fetch only flag rows whose CONDSTORE modification sequence advanced. */
export async function fetchChangedMessageFlags(
  client: MirrorImapClient,
  changedSince: bigint
): Promise<MessageFlagSnapshot[]> {
  const returned = new Map<number, MessageFlagSnapshot>();
  let retainedBytes = 2;
  let retainedFlags = 0;

  for await (const msg of client.fetch(
    "1:*",
    { uid: true, flags: true },
    { uid: true, changedSince }
  )) {
    if (!Number.isInteger(msg.uid)) continue;
    if (msg.flags === undefined) {
      throw new Error(`IMAP changed flag fetch omitted FLAGS for UID ${msg.uid}`);
    }
    const snapshot = { uid: msg.uid, flags: [...msg.flags] };
    const footprint = flagSnapshotFootprint(snapshot);
    const previous = returned.get(msg.uid);
    if (previous) {
      const previousFootprint = flagSnapshotFootprint(previous);
      retainedBytes -= previousFootprint.bytes;
      retainedFlags -= previousFootprint.flags;
    }
    retainedBytes += footprint.bytes;
    retainedFlags += footprint.flags;
    if (retainedBytes > MAX_SYNC_FLAG_FETCH_BYTES || retainedFlags > MAX_SYNC_FLAGS_PER_FETCH) {
      throw new FlagFetchBudgetExceededError("IMAP changed flag fetch exceeded the aggregate memory budget");
    }
    returned.set(msg.uid, snapshot);
  }

  return [...returned.values()];
}

export async function searchUidsSince(
  client: MirrorImapClient,
  since: Date,
  uidRange?: string
): Promise<number[]> {
  const query: Record<string, unknown> = { since };
  if (uidRange) query.uid = uidRange;

  const uids: number[] = [];
  for await (const msg of client.fetch(query, { uid: true }, { uid: true })) {
    uids.push(msg.uid);
  }
  return uids;
}

export async function searchUidsBefore(
  client: MirrorImapClient,
  before: Date,
  uidRange?: string
): Promise<number[]> {
  const query: Record<string, unknown> = { before };
  if (uidRange) query.uid = uidRange;

  const uids: number[] = [];
  for await (const msg of client.fetch(query, { uid: true }, { uid: true })) {
    uids.push(msg.uid);
  }
  return uids;
}

export async function searchAllUids(client: MirrorImapClient, since?: Date): Promise<number[]> {
  const uids: number[] = [];
  for await (const uid of iterateAllUids(client, since)) {
    uids.push(uid);
  }
  return uids;
}

export async function* iterateAllUids(client: MirrorImapClient, since?: Date): AsyncIterable<number> {
  const query: Record<string, unknown> = since ? { since } : { all: true };
  for await (const msg of client.fetch(query, { uid: true }, { uid: true })) {
    yield msg.uid;
  }
}

async function streamToBuffer(stream: AsyncIterable<Buffer | Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ImapFlow downloads a full message with sequential partial FETCH commands.
// One MiB keeps memory bounded while avoiding hundreds of 64 KiB round trips
// for a large RFC822 source.
const FULL_MESSAGE_DOWNLOAD_CHUNK_BYTES = 1024 * 1024;

/**
 * A message UID present at metadata-sync time is no longer in its folder at
 * body-fetch time — moved by a provider filter, or deleted. Terminal and benign:
 * the body lane catches this and soft-deletes the row (`MOVED_OUT`) instead of
 * erroring the account. Without it a gone UID makes `fetchOne` return false, the
 * download fallback fetches `false.content` (undefined) and crashes `streamToBuffer`,
 * and because the body lane is the one un-try/caught reader that throw bricks the
 * whole account to BROKEN and re-loops every backfill.
 */
export class MessageMovedError extends Error {
  constructor(
    public readonly uid: string,
    public readonly folderPath: string
  ) {
    super(`message uid ${uid} is no longer present in ${folderPath}`);
    this.name = "MessageMovedError";
  }
}

export {
  PARSED_BODY_BATCH_MAX_MESSAGES,
  PARSED_BODY_BATCH_MAX_SOURCE_BYTES,
  PARSED_BODY_BATCH_MAX_TOTAL_SOURCE_BYTES
};

export interface BodyBatchFetchResult {
  bodies: Array<{ message: ImapMessage; body: MessageBodyInput }>;
  missingMessages: ImapMessage[];
}

function isParsedOnlySourceTruncated(
  rawBytes: number,
  message: ImapMessage,
  configuredCap: number
): boolean {
  const expectedBytes = Number(message.size_bytes);
  if (
    Number.isSafeInteger(expectedBytes)
    && expectedBytes > 0
    && expectedBytes <= configuredCap
  ) {
    return rawBytes !== expectedBytes;
  }
  return rawBytes >= configuredCap;
}

/**
 * Fetches several small parsed-only bodies with one UID FETCH command.
 *
 * ImapFlow backpressures its FETCH iterator one response at a time. This
 * function drains the bounded FETCH before returning so body storage never
 * pauses an active IMAP command. Larger messages continue through download(),
 * which streams in chunks and never retains the full source.
 */
export async function fetchFullMessageBodyBatch(
  client: MirrorImapClient,
  config: AppConfig,
  messages: ImapMessage[],
  options: { skipMailboxLock?: boolean } = {}
): Promise<BodyBatchFetchResult> {
  if (messages.length === 0) return { bodies: [], missingMessages: [] };
  if (config.BODY_STORAGE_MODE !== "parsed_only") {
    throw new Error("body batch fetch requires BODY_STORAGE_MODE=parsed_only");
  }
  if (messages.length > PARSED_BODY_BATCH_MAX_MESSAGES) {
    throw new Error(
      `body batch fetch exceeds ${PARSED_BODY_BATCH_MAX_MESSAGES} messages`
    );
  }

  const folderPath = messages[0].folder_path;
  if (messages.some((message) => message.folder_path !== folderPath)) {
    throw new Error("body batch fetch requires one mailbox folder");
  }

  const requestedByUid = new Map<number, ImapMessage>();
  const sourceLimit = Math.min(
    config.BODY_RAW_MAX_BYTES,
    PARSED_BODY_BATCH_MAX_SOURCE_BYTES
  );
  let totalSourceBytes = 0;
  for (const message of messages) {
    const uid = Number(message.uid);
    if (!Number.isSafeInteger(uid) || uid <= 0) {
      throw new Error(`invalid body batch UID: ${message.uid}`);
    }
    if (requestedByUid.has(uid)) {
      throw new Error(`duplicate body batch UID: ${message.uid}`);
    }
    const size = Number(message.size_bytes);
    if (!Number.isSafeInteger(size) || size <= 0 || size > sourceLimit) {
      throw new Error(`body batch UID ${message.uid} has unsafe source size`);
    }
    totalSourceBytes += size;
    requestedByUid.set(uid, message);
  }
  if (totalSourceBytes > PARSED_BODY_BATCH_MAX_TOTAL_SOURCE_BYTES) {
    throw new Error("body batch fetch exceeds aggregate source limit");
  }

  const lock = options.skipMailboxLock ? null : await client.getMailboxLock(folderPath);
  try {
    const mailbox = client.mailbox;
    if (!mailbox || mailbox.path !== folderPath) {
      throw new Error(`body batch fetch expected ${folderPath} to be selected`);
    }
    const serverUidValidity = Number(mailbox.uidValidity);
    for (const message of messages) {
      if (serverUidValidity !== Number(message.uidvalidity)) {
        throw new Error("UIDVALIDITY changed before body batch fetch");
      }
    }

    const seen = new Set<number>();
    const bodies: BodyBatchFetchResult["bodies"] = [];
    for await (const fetched of client.fetch(
      [...requestedByUid.keys()],
      {
        source: {
          start: 0,
          maxLength: sourceLimit
        }
      },
      { uid: true }
    )) {
      const uid = Number(fetched.uid);
      const message = requestedByUid.get(uid);
      if (!message || seen.has(uid) || !fetched.source) continue;
      const source = Buffer.isBuffer(fetched.source)
        ? fetched.source
        : Buffer.from(fetched.source);
      // RFC822.SIZE selected this message for the bounded batch. If the server
      // returns a different byte count, do not trust the estimate or retain the
      // parsed result in this batch. The caller retries it through the individual
      // streaming path after the set FETCH has drained.
      if (source.length !== Number(message.size_bytes)) continue;
      seen.add(uid);

      const parsed = await parseRawMimeStream((async function* () {
        yield source;
      })());
      const rawTruncated = isParsedOnlySourceTruncated(
        parsed.rawBytes,
        message,
        config.BODY_RAW_MAX_BYTES
      );
      const mimeStructure = message.mime_structure;
      const selected = selectBodyTextPart(mimeStructure);

      bodies.push({
        message,
        body: {
          messageId: message.id,
          rawMime: Buffer.alloc(0),
          rawMimeSha256: rawTruncated ? null : parsed.rawMimeSha256,
          rawBytes: parsed.rawBytes,
          rawTruncated,
          bodyText: parsed.bodyText,
          bodyHtml: parsed.bodyHtml,
          bodyPlain: parsed.bodyPlain,
          selectedTextPart: selected?.part ?? null,
          selectedTextFormat: selected?.format ?? null,
          headersJson: Object.keys(parsed.headersJson).length > 0
            ? parsed.headersJson
            : message.headers_json,
          mimeStructure,
          parserWarnings: rawTruncated
            ? [...parsed.parserWarnings, "artifact_evidence_omitted_raw_truncated"]
            : parsed.parserWarnings,
          evidence: rawTruncated ? [] : parsed.evidence
        }
      });
    }

    return {
      bodies,
      missingMessages: messages.filter((message) => !seen.has(Number(message.uid)))
    };
  } finally {
    lock?.release();
  }
}

export async function fetchFullMessageBody(
  client: MirrorImapClient,
  config: AppConfig,
  message: ImapMessage,
  options: { skipMailboxLock?: boolean } = {}
): Promise<MessageBodyInput> {
  // When the caller already holds the mailbox lock for this message's folder (the
  // history-backfill snapshot loop does), re-acquiring it here would DEADLOCK —
  // imapflow's mailbox lock is a non-reentrant per-connection mutex — and the command
  // timeout would then close the whole connection. Such callers pass skipMailboxLock,
  // and we reuse the already-selected mailbox after asserting it is the expected folder.
  const lock = options.skipMailboxLock ? null : await client.getMailboxLock(message.folder_path);

  try {
    const mailbox = client.mailbox;
    if (options.skipMailboxLock && (!mailbox || mailbox.path !== message.folder_path)) {
      throw new Error(
        `fetchFullMessageBody: expected ${message.folder_path} to be selected when skipping the mailbox lock`
      );
    }
    if (mailbox) {
      const serverUidValidity = Number(mailbox.uidValidity);
      const storedUidValidity = Number(message.uidvalidity);
      if (serverUidValidity !== storedUidValidity) {
        throw new Error("UIDVALIDITY changed before body fetch");
      }
    }

    const streamParsedOnly = config.BODY_STORAGE_MODE === "parsed_only";
    let fetched: FetchMessage | false | null = null;
    if (!streamParsedOnly) {
      fetched = await client.fetchOne(
        String(message.uid),
        {
          bodyStructure: true,
          headers: true,
          source: { start: 0, maxLength: config.BODY_RAW_MAX_BYTES }
        },
        { uid: true }
      );

      // The UID can vanish between metadata sync and this body fetch (a filter moved
      // it to another folder, or it was deleted). Treat a gone UID as a terminal,
      // benign "moved out" so the caller soft-deletes it instead of crashing the body
      // lane.
      if (!fetched) {
        throw new MessageMovedError(String(message.uid), message.folder_path);
      }
    }

    let rawMime: Buffer = Buffer.alloc(0);
    let rawBytes = 0;
    let rawMimeSha256: string | null | undefined;
    let parsed;
    if (streamParsedOnly) {
      const downloaded = await client.download(String(message.uid), undefined, {
        uid: true,
        maxBytes: config.BODY_RAW_MAX_BYTES,
        chunkSize: Math.min(FULL_MESSAGE_DOWNLOAD_CHUNK_BYTES, config.BODY_RAW_MAX_BYTES)
      });
      if (!downloaded || !downloaded.content) {
        throw new MessageMovedError(String(message.uid), message.folder_path);
      }
      const streamed = await parseRawMimeStream(downloaded.content);
      rawBytes = streamed.rawBytes;
      rawMimeSha256 = streamed.rawMimeSha256;
      parsed = streamed;
    } else {
      rawMime = fetched?.source
        ? (Buffer.isBuffer(fetched.source) ? fetched.source : Buffer.from(fetched.source))
        : Buffer.alloc(0);
      if (rawMime.length === 0) {
        const downloaded = await client.download(String(message.uid), undefined, {
          uid: true,
          maxBytes: config.BODY_RAW_MAX_BYTES,
          chunkSize: Math.min(FULL_MESSAGE_DOWNLOAD_CHUNK_BYTES, config.BODY_RAW_MAX_BYTES)
        });
        if (!downloaded || !downloaded.content) {
          throw new MessageMovedError(String(message.uid), message.folder_path);
        }
        rawMime = await streamToBuffer(downloaded.content);
      }
      rawBytes = rawMime.length;
      parsed = await parseRawMime(rawMime);
    }

    const rawTruncated = streamParsedOnly
      ? isParsedOnlySourceTruncated(rawBytes, message, config.BODY_RAW_MAX_BYTES)
      : rawBytes >= config.BODY_RAW_MAX_BYTES;
    if (rawTruncated) rawMimeSha256 = null;
    const mimeStructure = fetched?.bodyStructure ?? message.mime_structure;
    const selected = selectBodyTextPart(mimeStructure);

    return {
      messageId: message.id,
      rawMime,
      rawMimeSha256,
      rawBytes,
      rawTruncated,
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
      bodyPlain: parsed.bodyPlain,
      selectedTextPart: selected?.part ?? null,
      selectedTextFormat: selected?.format ?? null,
      headersJson: Object.keys(parsed.headersJson).length > 0 ? parsed.headersJson : message.headers_json,
      mimeStructure,
      parserWarnings: rawTruncated
        ? [...parsed.parserWarnings, "artifact_evidence_omitted_raw_truncated"]
        : parsed.parserWarnings,
      evidence: rawTruncated ? [] : parsed.evidence
    };
  } finally {
    lock?.release();
  }
}
