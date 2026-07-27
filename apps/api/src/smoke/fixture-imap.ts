import type {
  DownloadResult,
  FetchMessage,
  MailboxListItem,
  MailboxLock,
  MailboxStatus,
  MirrorImapClient
} from "../imap-client.js";

export interface FixtureMessage {
  uid: number;
  subject: string;
  from: string;
  to: string;
  internalDate: Date;
  flags?: string[];
  raw: Buffer;
  bodyStructure?: unknown;
}

export interface FixtureFolder {
  path: string;
  delimiter?: string;
  specialUse?: string;
  uidValidity: number;
  messages: FixtureMessage[];
}

export class FixtureImapClient implements MirrorImapClient {
  mailbox: MailboxStatus | false | null = null;

  private readonly foldersByPath: Map<string, FixtureFolder>;

  constructor(private readonly folders: FixtureFolder[]) {
    this.foldersByPath = new Map(folders.map((folder) => [folder.path, folder]));
  }

  async logout(): Promise<void> {}

  async list(): Promise<MailboxListItem[]> {
    return this.folders.map((folder) => ({
      path: folder.path,
      delimiter: folder.delimiter,
      specialUse: folder.specialUse
    }));
  }

  async getMailboxLock(path: string): Promise<MailboxLock> {
    const folder = this.foldersByPath.get(path);
    if (!folder) throw new Error(`Fixture folder not found: ${path}`);

    this.mailbox = {
      path,
      uidValidity: folder.uidValidity,
      uidNext: Math.max(0, ...folder.messages.map((message) => message.uid)) + 1,
      exists: folder.messages.length
    };

    return { release: () => undefined };
  }

  async *fetch(
    range: string | number[] | Record<string, unknown>,
    query: Record<string, unknown>
  ): AsyncIterable<FetchMessage> {
    const messages = this.selectedMessages(range);
    const metadataRequested = Boolean(query.envelope || query.headers || query.bodyStructure);
    const flagsRequested = query.flags === true;
    const sourceRequest = typeof query.source === "object" && query.source !== null
      ? query.source as { maxLength?: unknown }
      : null;
    const maxSourceLength = typeof sourceRequest?.maxLength === "number"
      ? sourceRequest.maxLength
      : undefined;

    for (const message of messages) {
      if (sourceRequest) {
        yield {
          ...this.toFetchMessage(message),
          source: maxSourceLength === undefined
            ? message.raw
            : message.raw.subarray(0, maxSourceLength)
        };
        continue;
      }
      yield metadataRequested
        ? this.toFetchMessage(message)
        : flagsRequested
          ? { uid: message.uid, flags: new Set(message.flags ?? []) }
          : { uid: message.uid };
    }
  }

  async fetchOne(
    range: string,
    query: Record<string, unknown> = {},
    options?: Record<string, unknown>
  ): Promise<FetchMessage | false | null> {
    void options;
    const uid = Number(range);
    const message = this.messagesForCurrentMailbox().find((candidate) => candidate.uid === uid);
    if (!message) return false;
    const maxLength = typeof query.source === "object"
      && query.source !== null
      && "maxLength" in query.source
      && typeof query.source.maxLength === "number"
      ? query.source.maxLength
      : undefined;
    const source = maxLength === undefined ? message.raw : message.raw.subarray(0, maxLength);

    return {
      ...this.toFetchMessage(message),
      source
    };
  }

  async download(range: string, part?: string, options: Record<string, unknown> = {}): Promise<DownloadResult> {
    void part;
    const uid = Number(range);
    const message = this.messagesForCurrentMailbox().find((candidate) => candidate.uid === uid);
    if (!message) return {};
    const maxBytes = typeof options.maxBytes === "number" ? options.maxBytes : undefined;
    const raw = maxBytes === undefined ? message.raw : message.raw.subarray(0, maxBytes);

    return {
      content: (async function* stream() {
        yield raw;
      })()
    };
  }

  private selectedMessages(range: string | number[] | Record<string, unknown>): FixtureMessage[] {
    let messages = this.messagesForCurrentMailbox();

    if (Array.isArray(range)) {
      const wanted = new Set(range);
      messages = messages.filter((message) => wanted.has(message.uid));
    } else if (typeof range === "object") {
      const since = range.since;
      if (since instanceof Date) {
        messages = messages.filter((message) => message.internalDate >= since);
      }

      const before = range.before;
      if (before instanceof Date) {
        messages = messages.filter((message) => message.internalDate < before);
      }

      if (range.uid && typeof range.uid === "string") {
        const [startRaw, endRaw] = range.uid.split(":");
        const start = Number(startRaw);
        const end = Number(endRaw);
        messages = messages.filter((message) => message.uid >= start && message.uid <= end);
      }
    }

    return [...messages].sort((a, b) => a.uid - b.uid);
  }

  private messagesForCurrentMailbox(): FixtureMessage[] {
    if (!this.mailbox) return [];
    return this.foldersByPath.get(this.mailbox.path)?.messages ?? [];
  }

  private toFetchMessage(message: FixtureMessage): FetchMessage {
    const messageId = `<dry-run-${message.uid}@example.test>`;

    return {
      uid: message.uid,
      internalDate: message.internalDate,
      size: message.raw.length,
      flags: new Set(message.flags ?? []),
      envelope: {
        messageId,
        subject: message.subject,
        from: [parseAddress(message.from)],
        to: [parseAddress(message.to)]
      },
      headers: Buffer.from(
        [
          `Message-ID: ${messageId}`,
          "References: <dry-run-root@example.test>",
          "In-Reply-To: <dry-run-root@example.test>"
        ].join("\r\n")
      ),
      bodyStructure: message.bodyStructure ?? { part: "1", type: "text/plain", size: message.raw.length }
    };
  }
}

export function makeTextMessage(input: {
  uid: number;
  subject: string;
  from: string;
  to: string;
  body: string;
  internalDate?: Date;
  flags?: string[];
  bodyStructure?: unknown;
}): FixtureMessage {
  return {
    uid: input.uid,
    subject: input.subject,
    from: input.from,
    to: input.to,
    internalDate: input.internalDate ?? new Date(),
    flags: input.flags ?? [],
    raw: rawMime({
      from: `${localName(input.from)} <${input.from}>`,
      to: `${localName(input.to)} <${input.to}>`,
      subject: input.subject,
      messageId: `<dry-run-${input.uid}@example.test>`,
      body: input.body
    }),
    bodyStructure: input.bodyStructure ?? { part: "1", type: "text/plain", size: input.body.length }
  };
}

export function rawMime(input: {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  body: string;
}): Buffer {
  return Buffer.from(
    [
      `From: ${input.from}`,
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      `Message-ID: ${input.messageId}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      input.body
    ].join("\r\n")
  );
}

function parseAddress(address: string): { address: string; name: string } {
  return { address, name: localName(address) };
}

function localName(address: string): string {
  return address.split("@")[0];
}
