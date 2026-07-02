import type { Readable } from "node:stream";
import type { ImapFlow } from "imapflow";
import type { AppConfig } from "./config.js";
import type { PgClient, PgPool } from "./db.js";
import { NotFoundError, UnfetchableContentError } from "./errors.js";
import { closeImap, connectImap, uidValidityMatches, uidValidityMismatchMessage } from "./imap-connect.js";
import { cleanBody } from "./mcp/shared.js";
import { loadMessageAndAccount } from "./message-loader.js";
import { MirrorRepository } from "./repository.js";
import type { ImapAccount } from "./types.js";

/**
 * Attachment bytes / raw MIME / headers / clean-body read surface (email-004,
 * ADR 0020). This module lives OUTSIDE src/mcp/ on purpose: the agent MCP surface
 * is the five read tools and intentionally exposes ONLY attachment METADATA (the
 * server instructions say "NO attachment bytes"). Attachment-byte download, raw
 * MIME, full headers, and clean-body live here, reachable via the lib barrel +
 * the API_TOKEN HTTP routes + the CLI — never as a sixth MCP tool.
 *
 * Storage decision (see ADR 0020):
 * - Attachment METADATA is mirrored (imap_attachments) → read from the mirror.
 * - Attachment BYTES are NEVER mirrored → ALWAYS an on-demand IMAP part FETCH.
 * - Raw MIME is mirrored only when BODY_STORAGE_MODE=raw_mime; under parsed_only
 *   (the prod default) raw_mime is NULL → on-demand FETCH of the whole message.
 * - Parsed headers (headers_json) + body text ARE mirrored → read from the mirror,
 *   with an on-demand FETCH fallback only when the body row is absent.
 *
 * The on-demand fetch uses a narrow read-only {@link ContentImapClient} whose
 * socket comes from the one shared {@link connectImap} prelude (decrypt +
 * assertSafeImapTarget + the close-on-connect-error guard) but exposes ONLY
 * `downloadPart()` / `downloadPartStream()` / `fetchOneSource()` (all READs). It is NOT the sync adapter
 * (ThrottledImapClient stays untouched, so sync-adapter-read-only.test.ts holds)
 * and it never writes.
 */

/** One attachment's mirrored metadata (no bytes). */
export interface AttachmentInfo {
  attachmentId: string;
  messageId: string;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  partNumber: string | null;
  contentId: string | null;
  inline: boolean;
}

/** Downloaded attachment bytes + the metadata they belong to. */
export interface AttachmentDownload extends AttachmentInfo {
  /** The decoded part bytes (Content-Transfer-Encoding already removed). */
  content: Buffer;
}

/**
 * A STREAMING attachment download + the metadata it belongs to. The bytes are never
 * buffered in full — `stream` is imapflow's decoded part stream (Content-Transfer-Encoding
 * already removed) piped straight from the IMAP socket, so peak memory stays flat
 * regardless of file size. The IMAP folder lock + connection are held open for the
 * stream's lifetime; the caller MUST call `close()` once the stream is fully consumed OR
 * on error/abort. `close()` is idempotent and also fires automatically on the stream's
 * `end`/`error`, so a forgotten call can never leak the lock/connection.
 *
 * imapflow caps the DECODED stream at `maxBytes` (its byte limiter is the last pipeline
 * stage): if the file exceeds it the stream is truncated silently, so a caller that must
 * serve only complete files should treat "bytes read >= maxBytes" as truncated.
 */
export interface AttachmentDownloadStream extends AttachmentInfo {
  stream: Readable;
  close(): Promise<void>;
}

/** Raw RFC-822 bytes of a message, plus whether they came from the mirror. */
export interface RawMimeResult {
  messageId: string;
  raw: Buffer;
  /** "mirror" = the stored raw_mime; "fetch" = an on-demand IMAP FETCH. */
  source: "mirror" | "fetch";
  truncated: boolean;
}

/** A message's parsed headers, plus their provenance. */
export interface MessageHeadersResult {
  messageId: string;
  headers: Record<string, string>;
  source: "mirror" | "fetch";
}

/** A cleaned message body (signature + quoted-reply stripped unless includeQuoted). */
export interface CleanBodyResultDetail {
  messageId: string;
  body: string | null;
  truncated: boolean;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  part_number: string | null;
  content_id: string | null;
  disposition: string | null;
}

function toAttachmentInfo(row: AttachmentRow): AttachmentInfo {
  return {
    attachmentId: row.id,
    messageId: row.message_id,
    filename: row.filename,
    contentType: row.mime_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    partNumber: row.part_number,
    contentId: row.content_id,
    inline: (row.disposition ?? "").toLowerCase() === "inline"
  };
}

/**
 * Narrow READ-ONLY IMAP client for on-demand byte/raw fetches. Exposes only
 * `download()` (one BODYSTRUCTURE part, decoded) and `fetchOneSource()` (the whole
 * message source) — both reads. Never used by the sync engine; never writes.
 */
export class ContentImapClient {
  private constructor(private readonly client: ImapFlow) {}

  static async connect(pool: PgPool, config: AppConfig, account: ImapAccount): Promise<ContentImapClient> {
    // Socket + SSRF guard + decrypt + the close-on-connect-error guard come from the
    // one shared connect prelude (imap-connect.ts); this client only adds the
    // download/fetch read verb surface on top (ADR 0020/0022).
    const client = await connectImap(pool, config, account);
    return new ContentImapClient(client);
  }

  /**
   * Select + lock `folderPath`, assert the live UIDVALIDITY still equals what we
   * mirrored (a reset would invalidate the UID), then run the read `op` under the
   * lock and release it in `finally`. The mutate side (`MailboxMutator.withUidScope`)
   * has the identical lock → assert → finally-release shape; this is the read twin
   * (it keeps the fetch path's own plain-Error assertion via `assertUidValidity`).
   * Extracted so `downloadPart`/`fetchOneSource` no longer copy-paste the scope.
   */
  private async withUidScope<T>(folderPath: string, uidValidity: number, op: () => Promise<T>): Promise<T> {
    const lock = await this.client.getMailboxLock(folderPath);
    try {
      this.assertUidValidity(folderPath, uidValidity);
      return await op();
    } finally {
      lock.release();
    }
  }

  /**
   * Download one BODYSTRUCTURE part of the message at `uid` in `folderPath`,
   * asserting the live UIDVALIDITY still matches what we mirrored so a reset can
   * never make us fetch a different message. imapflow decodes the part's
   * Content-Transfer-Encoding, so the returned Buffer is the real bytes.
   */
  async downloadPart(
    folderPath: string,
    uidValidity: number,
    uid: number,
    part: string,
    maxBytes: number
  ): Promise<Buffer> {
    return this.withUidScope(folderPath, uidValidity, async () => {
      const result = await this.client.download(String(uid), part, { uid: true, maxBytes });
      return await streamToBuffer(result.content);
    });
  }

  /**
   * Like {@link downloadPart} but returns imapflow's decoded part STREAM instead of
   * buffering it, so large parts never sit in memory. The folder lock is acquired and
   * UIDVALIDITY asserted here (a mismatch throws BEFORE any stream exists), then OWNERSHIP
   * of the lock transfers to the caller: the returned `release` unlocks the mailbox and
   * MUST be called once the stream is done/aborted (the higher-level
   * {@link downloadAttachmentStream} wires `release` into its `close()`). If anything
   * fails before the stream is handed back, the lock is released here.
   */
  async downloadPartStream(
    folderPath: string,
    uidValidity: number,
    uid: number,
    part: string,
    maxBytes: number
  ): Promise<{ stream: Readable; release: () => void }> {
    const lock = await this.client.getMailboxLock(folderPath);
    try {
      this.assertUidValidity(folderPath, uidValidity);
      const result = await this.client.download(String(uid), part, { uid: true, maxBytes });
      return { stream: result.content as Readable, release: () => lock.release() };
    } catch (err) {
      lock.release();
      throw err;
    }
  }

  /** Fetch the whole RFC-822 source (capped at `maxBytes`). Used for raw MIME /
   * header fallbacks when the mirror does not hold the bytes. */
  async fetchOneSource(
    folderPath: string,
    uidValidity: number,
    uid: number,
    maxBytes: number
  ): Promise<Buffer> {
    return this.withUidScope(folderPath, uidValidity, async () => {
      const fetched = await this.client.fetchOne(String(uid), { source: { start: 0, maxLength: maxBytes } }, { uid: true });
      if (fetched && (fetched as { source?: Buffer }).source) {
        return Buffer.from((fetched as { source: Buffer }).source);
      }
      const result = await this.client.download(String(uid), undefined, { uid: true, maxBytes });
      return await streamToBuffer(result.content);
    });
  }

  private assertUidValidity(folderPath: string, uidValidity: number): void {
    const mailbox = this.client.mailbox as { uidValidity?: bigint | number } | false | null;
    // Shared fail-closed UIDVALIDITY check (imap-connect.ts) — same property as
    // MailboxMutator's mutate guard, but the fetch path keeps its own plain Error.
    if (!uidValidityMatches(mailbox, uidValidity)) {
      throw new Error(
        uidValidityMismatchMessage(
          folderPath,
          uidValidity,
          (mailbox as { uidValidity?: bigint | number }).uidValidity,
          "fetch"
        )
      );
    }
  }

  async logout(): Promise<void> {
    await this.client.logout();
  }

  close(): void {
    this.client.close();
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
 * List a message's attachment metadata from the mirror (imap_attachments). Bytes
 * are never stored, so this is a cheap read-only SELECT — no IMAP round-trip.
 */
export async function listAttachments(
  pool: PgPool,
  config: AppConfig,
  messageId: string
): Promise<AttachmentInfo[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<AttachmentRow>(
      `
      SELECT id, message_id, filename, mime_type, size_bytes, part_number, content_id, disposition
      FROM public.imap_attachments
      WHERE message_id = $1
      ORDER BY NULLIF(regexp_replace(coalesce(part_number, ''), '[^0-9]', '', 'g'), '')::bigint NULLS LAST, part_number
      `,
      [messageId]
    );
    return result.rows.map(toAttachmentInfo);
  } finally {
    client.release();
  }
}

/** Get one attachment's metadata by its attachment id (or null if not found). */
export async function getAttachmentMetadata(
  pool: PgPool,
  config: AppConfig,
  attachmentId: string
): Promise<AttachmentInfo | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<AttachmentRow>(
      `
      SELECT id, message_id, filename, mime_type, size_bytes, part_number, content_id, disposition
      FROM public.imap_attachments
      WHERE id = $1
      `,
      [attachmentId]
    );
    const row = result.rows[0];
    return row ? toAttachmentInfo(row) : null;
  } finally {
    client.release();
  }
}

/**
 * Download an attachment's BYTES by its mirror attachment id. Attachment bytes are
 * never mirrored, so this ALWAYS does an on-demand IMAP part FETCH (ADR 0020): it
 * resolves the message's folder + UIDVALIDITY + UID and the attachment's
 * BODYSTRUCTURE part_number, connects a read-only {@link ContentImapClient}, and
 * downloads that one part (UIDVALIDITY-guarded).
 */
export async function downloadAttachment(
  pool: PgPool,
  config: AppConfig,
  attachmentId: string
): Promise<AttachmentDownload> {
  const { stream, close, ...meta } = await downloadAttachmentStream(pool, config, attachmentId);
  try {
    const content = await streamToBuffer(stream);
    return { ...meta, content };
  } finally {
    await close();
  }
}

/**
 * STREAMING variant of {@link downloadAttachment}: same on-demand IMAP part fetch and the
 * IDENTICAL preflight (metadata → 404, missing part_number → 422, message/account resolve,
 * connect, UIDVALIDITY assert — every failure throws BEFORE the stream so the HTTP status
 * is always decided before headers are sent), but returns imapflow's decoded part stream
 * instead of a Buffer so peak memory stays flat regardless of file size. `maxBytes` defaults
 * to `config.BODY_RAW_MAX_BYTES`; the caller owns the returned `close()` (see
 * {@link AttachmentDownloadStream}).
 */
export async function downloadAttachmentStream(
  pool: PgPool,
  config: AppConfig,
  attachmentId: string,
  opts: { maxBytes?: number } = {}
): Promise<AttachmentDownloadStream> {
  const meta = await getAttachmentMetadata(pool, config, attachmentId);
  if (!meta) throw new NotFoundError(`Attachment not found: ${attachmentId}`);
  if (!meta.partNumber) {
    throw new UnfetchableContentError(
      `Attachment ${attachmentId} has no BODYSTRUCTURE part number; cannot fetch its bytes`
    );
  }

  const maxBytes = opts.maxBytes ?? config.BODY_RAW_MAX_BYTES;
  const repository = new MirrorRepository(pool, config);
  const { message, account } = await loadMessageAndAccount(repository, meta.messageId);

  const reader = await ContentImapClient.connect(pool, config, account);
  let scope: { stream: Readable; release: () => void };
  try {
    scope = await reader.downloadPartStream(
      message.folder_path,
      Number(message.uidvalidity),
      Number(message.uid),
      meta.partNumber,
      maxBytes
    );
  } catch (err) {
    // Preflight/scope setup failed after connect — tear the connection down and rethrow
    // so the caller sees the typed error (no stream, no leaked socket).
    await closeImap(reader);
    throw err;
  }

  // One memoized teardown: release the folder lock, then close the connection. Concurrent
  // callers (the caller's explicit close + the end/error auto-close below) await the SAME
  // promise, so teardown runs exactly once and is always awaitable.
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      closing = (async () => {
        // Best-effort teardown that must NEVER reject: it runs from the unawaited
        // 'close'/'error' listeners below (a rejection there becomes an
        // unhandledRejection and can crash the process), and from the buffered
        // path's `finally { await close() }` (a reject there would mask the real
        // error). `closeImap` already swallows a logout() failure; this guards the
        // lock release + the hard-close fallback too.
        try {
          scope.release();
          await closeImap(reader);
        } catch {
          /* teardown is best-effort */
        }
      })();
    }
    return closing;
  };
  // `close` fires on normal completion (autoDestroy → 'close' after 'end'), on abort
  // (consumer destroys the stream → 'close'), and 'error' covers failures — so the lock +
  // connection are always released even if the caller forgets to await close().
  scope.stream.once("close", () => void close());
  scope.stream.once("error", () => void close());

  return { ...meta, stream: scope.stream, close };
}

/**
 * Get the raw RFC-822 bytes of a message. Returns the mirrored `raw_mime` when it
 * was stored (BODY_STORAGE_MODE=raw_mime); under parsed_only (raw_mime NULL) it
 * does an on-demand IMAP FETCH of the whole message source (ADR 0020).
 */
export async function getRawMime(
  pool: PgPool,
  config: AppConfig,
  messageId: string
): Promise<RawMimeResult> {
  const stored = await pool.connect();
  let mirrored: { raw_mime: Buffer | null; raw_truncated: boolean } | undefined;
  try {
    const result = await stored.query<{ raw_mime: Buffer | null; raw_truncated: boolean }>(
      `
      SELECT raw_mime, raw_truncated
      FROM public.imap_message_bodies
      WHERE message_id = $1
      `,
      [messageId]
    );
    mirrored = result.rows[0];
  } finally {
    stored.release();
  }

  if (mirrored && mirrored.raw_mime !== null) {
    return { messageId, raw: mirrored.raw_mime, source: "mirror", truncated: mirrored.raw_truncated };
  }

  // raw_mime not stored (parsed_only) or no body row yet → on-demand FETCH.
  const repository = new MirrorRepository(pool, config);
  const { message, account } = await loadMessageAndAccount(repository, messageId);
  const reader = await ContentImapClient.connect(pool, config, account);
  try {
    const raw = await reader.fetchOneSource(
      message.folder_path,
      Number(message.uidvalidity),
      Number(message.uid),
      config.BODY_RAW_MAX_BYTES
    );
    return { messageId, raw, source: "fetch", truncated: raw.length >= config.BODY_RAW_MAX_BYTES };
  } finally {
    await closeImap(reader);
  }
}

/** Project a stored headers_json blob to a flat string→string map (full headers). */
function projectHeaders(raw: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
    else if (Array.isArray(value)) out[key] = value.map((v) => String(v)).join(", ");
    else out[key] = JSON.stringify(value);
  }
  return out;
}

/** The "basic" threading-header subset (Nylas include_basic_headers parity). */
const BASIC_HEADER_KEYS = new Set([
  "message-id",
  "in-reply-to",
  "references",
  "subject",
  "from",
  "to",
  "cc",
  "date"
]);

/**
 * Get a message's parsed headers from the mirror (headers_json). `basic: true`
 * returns only the threading-relevant subset (Message-ID/In-Reply-To/References/…);
 * otherwise every parsed header is returned. When the body row is absent (headers
 * not yet synced) it falls back to an on-demand FETCH + parse of the source.
 */
export async function getMessageHeaders(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  options: { basic?: boolean } = {}
): Promise<MessageHeadersResult> {
  const client = await pool.connect();
  let row: { headers_json: Record<string, unknown> | null; body_headers: Record<string, unknown> | null } | undefined;
  try {
    const result = await client.query<{
      headers_json: Record<string, unknown> | null;
      body_headers: Record<string, unknown> | null;
    }>(
      `
      SELECT m.headers_json, b.headers_json AS body_headers
      FROM public.imap_messages m
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
      WHERE m.id = $1
      `,
      [messageId]
    );
    row = result.rows[0];
  } finally {
    client.release();
  }
  if (!row) throw new NotFoundError(`Message not found: ${messageId}`);

  // Prefer the body's fully-parsed headers (whole-message parse); fall back to the
  // message row's envelope headers_json (always present from metadata sync).
  const merged = { ...projectHeaders(row.headers_json), ...projectHeaders(row.body_headers) };
  let source: "mirror" | "fetch" = "mirror";
  let headers = merged;

  if (Object.keys(headers).length === 0) {
    // Nothing stored — on-demand FETCH + parse the source headers.
    const { parseHeaders } = await import("./mime.js");
    const repository = new MirrorRepository(pool, config);
    const { message, account } = await loadMessageAndAccount(repository, messageId);
    const reader = await ContentImapClient.connect(pool, config, account);
    try {
      const raw = await reader.fetchOneSource(
        message.folder_path,
        Number(message.uidvalidity),
        Number(message.uid),
        config.BODY_RAW_MAX_BYTES
      );
      const headerBlock = raw.toString("utf8").split(/\r?\n\r?\n/)[0];
      headers = parseHeaders(headerBlock);
      source = "fetch";
    } finally {
      await closeImap(reader);
    }
  }

  if (options.basic) {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (BASIC_HEADER_KEYS.has(key.toLowerCase())) filtered[key] = value;
    }
    headers = filtered;
  }

  return { messageId, headers, source };
}

/**
 * Return a message's cleaned body text. Operates on the STORED body only (no IMAP
 * round-trip): coalesce(body_text, body_plain, selected_text_part), then reuse the
 * deterministic {@link cleanBody} heuristic from the MCP shared layer (drop the
 * `On … wrote:` quoted tail + the `-- ` signature unless includeQuoted) and clamp
 * to maxChars. No LLM — pure text parsing (ADR 0020).
 */
export async function cleanMessageBody(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  options: { includeQuoted?: boolean; maxChars?: number } = {}
): Promise<CleanBodyResultDetail> {
  const client: PgClient = await pool.connect();
  let row: { body_text: string | null; body_plain: string | null; selected_text_part: string | null } | undefined;
  try {
    const result = await client.query<{
      body_text: string | null;
      body_plain: string | null;
      selected_text_part: string | null;
    }>(
      `
      SELECT b.body_text, b.body_plain, b.selected_text_part
      FROM public.imap_messages m
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
      WHERE m.id = $1
      `,
      [messageId]
    );
    row = result.rows[0];
  } finally {
    client.release();
  }
  if (!row) throw new NotFoundError(`Message not found: ${messageId}`);

  const raw = row.body_text ?? row.body_plain ?? row.selected_text_part ?? null;
  const cleaned = cleanBody(raw, { includeQuoted: options.includeQuoted ?? false, maxChars: options.maxChars });
  return { messageId, body: cleaned.text, truncated: cleaned.truncated };
}

/**
 * Project an object down to a caller-selected set of top-level keys (field
 * selection to shrink read payloads — Nylas `select` / `--fields` parity). An
 * empty/absent selection returns the object unchanged. Unknown keys are ignored.
 */
export function selectFields<T extends object>(value: T, fields?: string[] | null): Partial<T> {
  if (!fields || fields.length === 0) return value;
  const wanted = new Set(fields.map((f) => f.trim()).filter(Boolean));
  if (wanted.size === 0) return value;
  const out: Partial<T> = {};
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (wanted.has(key as string)) out[key] = value[key];
  }
  return out;
}
