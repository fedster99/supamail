import type { ImapFlow } from "imapflow";
import type { AppConfig } from "./config.js";
import type { PgPool } from "./db.js";
import { connectImap } from "./imap-connect.js";
import { extractAttachmentMetadata, normalizeMessageId, parseHeaders, parseRawMime, selectBodyTextPart } from "./mime.js";
import {
  MAX_SYNC_ATTACHMENTS_PER_FETCH,
  MAX_SYNC_FLAG_FETCH_BYTES,
  MAX_SYNC_FLAGS_PER_FETCH,
  MAX_SYNC_METADATA_FETCH_BYTES,
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

export interface MailboxStatus {
  path: string;
  uidValidity: bigint | number;
  uidNext?: number;
  exists?: number;
  highestModseq?: bigint | number;
}

export interface MailboxLock {
  release(): void;
}

export interface MailboxListItem {
  path: string;
  delimiter?: string;
  specialUse?: string;
  flags?: Set<string>;
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
  content: AsyncIterable<Buffer | Uint8Array | string>;
}

export interface MirrorImapClient {
  mailbox: MailboxStatus | false | null;
  capabilities?: ReadonlyMap<string, boolean | number>;
  usable?: boolean;
  connect?(): Promise<void>;
  close?(): void;
  logout(): Promise<void>;
  list(): Promise<MailboxListItem[]>;
  getMailboxLock(path: string): Promise<MailboxLock>;
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

  constructor(
    private readonly client: ImapFlow,
    maxCommandsPerMinute: number,
    private readonly commandTimeoutMs: number,
    private readonly signal?: AbortSignal
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

  async getMailboxLock(path: string): Promise<MailboxLock> {
    await this.throttle.acquire(this.signal);
    return await this.withCommandTimeout("getMailboxLock", () => this.client.getMailboxLock(path));
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

    while (true) {
      const item = await this.withCommandTimeout("fetch", () => iterator.next());
      if (item.done) break;
      yield item.value;
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
    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        this.client.close();
        reject(new Error(`IMAP_COMMAND_TIMEOUT_MS exceeded during ${operation}`));
      }, this.commandTimeoutMs);
    });

    try {
      return await Promise.race([run(), timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
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
  const rawClient = await connectImap(pool, config, account, options);
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
    mimeStructure: msg.bodyStructure ?? null,
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
        throw new Error("IMAP flag fetch exceeded the aggregate memory budget");
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

    const fetched = await client.fetchOne(String(message.uid), {
      source: { start: 0, maxLength: config.BODY_RAW_MAX_BYTES },
      bodyStructure: true,
      headers: true
    }, { uid: true });

    // The UID can vanish between metadata sync and this body fetch (a filter moved
    // it to another folder, or it was deleted). Treat a gone UID as a terminal,
    // benign "moved out" so the caller soft-deletes it instead of crashing the body
    // lane (fetchOne returns false; the download fallback would otherwise stream
    // `false.content` and throw straight to the account-level catch).
    if (!fetched) {
      throw new MessageMovedError(String(message.uid), message.folder_path);
    }

    let rawMime: Buffer = fetched.source
      ? (Buffer.isBuffer(fetched.source) ? fetched.source : Buffer.from(fetched.source))
      : Buffer.alloc(0);
    if (rawMime.length === 0) {
      const downloaded = await client.download(String(message.uid), undefined, {
        uid: true,
        maxBytes: config.BODY_RAW_MAX_BYTES
      });
      if (!downloaded || !downloaded.content) {
        throw new MessageMovedError(String(message.uid), message.folder_path);
      }
      rawMime = await streamToBuffer(downloaded.content);
    }

    const rawBytes = rawMime.length;
    const rawTruncated = rawBytes >= config.BODY_RAW_MAX_BYTES;
    const mimeStructure = fetched && fetched.bodyStructure ? fetched.bodyStructure : message.mime_structure;
    const selected = selectBodyTextPart(mimeStructure);
    const parsed = await parseRawMime(rawMime);

    return {
      messageId: message.id,
      rawMime,
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
