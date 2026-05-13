import { ImapFlow } from "imapflow";
import type { AppConfig } from "./config.js";
import { decryptPassword } from "./crypto.js";
import type { PgPool } from "./db.js";
import { assertSafeImapTarget } from "./host-validation.js";
import { extractAttachmentMetadata, normalizeMessageId, parseHeaders, parseRawMime, selectBodyTextPart } from "./mime.js";
import { ImapThrottle } from "./throttle.js";
import type { ImapAccount, ImapMessage, MessageBodyInput, MessageMetadata } from "./types.js";

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
  threadId?: string;
  source?: Buffer;
}

export interface DownloadResult {
  content: AsyncIterable<Buffer | Uint8Array | string>;
}

export interface MirrorImapClient {
  mailbox: MailboxStatus | false | null;
  usable?: boolean;
  connect?(): Promise<void>;
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

  constructor(private readonly client: ImapFlow, maxCommandsPerMinute: number) {
    this.throttle = new ImapThrottle(maxCommandsPerMinute);
  }

  get mailbox(): MailboxStatus | false | null {
    return this.client.mailbox as MailboxStatus | false | null;
  }

  get usable(): boolean {
    return this.client.usable;
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async logout(): Promise<void> {
    await this.client.logout();
  }

  async list(): Promise<MailboxListItem[]> {
    await this.throttle.acquire();
    return (await this.client.list()) as MailboxListItem[];
  }

  async getMailboxLock(path: string): Promise<MailboxLock> {
    await this.throttle.acquire();
    return await this.client.getMailboxLock(path);
  }

  async *fetch(
    range: string | number[] | Record<string, unknown>,
    query: Record<string, unknown>,
    options?: Record<string, unknown>
  ): AsyncIterable<FetchMessage> {
    await this.throttle.acquire();
    yield* this.client.fetch(range as never, query as never, options as never) as AsyncIterable<FetchMessage>;
  }

  async fetchOne(
    range: string,
    query: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<FetchMessage | false | null> {
    await this.throttle.acquire();
    return await this.client.fetchOne(range, query as never, options as never) as FetchMessage | false | null;
  }

  async download(range: string, part?: string, options?: Record<string, unknown>): Promise<DownloadResult> {
    await this.throttle.acquire();
    return await this.client.download(range, part as never, options as never) as DownloadResult;
  }
}

export async function createImapClient(
  pool: PgPool,
  config: AppConfig,
  account: ImapAccount
): Promise<MirrorImapClient> {
  await assertSafeImapTarget(account.host, account.port, account.secure, {
    allowPrivateHosts: config.IMAP_ALLOW_PRIVATE_HOSTS
  });
  const password = await decryptPassword(pool, account.encrypted_password, config.IMAP_ENCRYPTION_KEY);
  const rawClient = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: {
      user: account.username,
      pass: password
    },
    logger: false,
    connectionTimeout: config.CONNECT_TIMEOUT_MS,
    greetingTimeout: config.CONNECT_TIMEOUT_MS,
    socketTimeout: config.IMAP_COMMAND_TIMEOUT_MS
  });

  await rawClient.connect();
  return new ThrottledImapClient(rawClient, config.IMAP_MAX_COMMANDS_PER_MINUTE);
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

export function parseMessageMetadata(msg: FetchMessage): MessageMetadata {
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
    providerThreadId: msg.threadId ?? null,
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

  for (let i = 0; i < uids.length; i += batchSize) {
    const batch = uids.slice(i, i + batchSize);
    if (batch.length === 0) continue;

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
        "precedence",
        "reply-to"
      ]
    }, { uid: true })) {
      messages.push(parseMessageMetadata(msg));
    }
  }

  return messages;
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

export async function fetchFullMessageBody(
  client: MirrorImapClient,
  config: AppConfig,
  message: ImapMessage
): Promise<MessageBodyInput> {
  const lock = await client.getMailboxLock(message.folder_path);

  try {
    const mailbox = client.mailbox;
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

    let rawMime: Buffer = fetched && fetched.source ? Buffer.from(fetched.source) : Buffer.alloc(0);
    if (rawMime.length === 0) {
      const downloaded = await client.download(String(message.uid), undefined, {
        uid: true,
        maxBytes: config.BODY_RAW_MAX_BYTES
      });
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
      parserWarnings: parsed.parserWarnings
    };
  } finally {
    lock.release();
  }
}
