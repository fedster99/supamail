import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { getConfig, type AppConfig } from "./config.js";
import { applyPublicMigrations, getPool, type PgPool } from "./db.js";
import { AccountBusyError, NoRecipientsError, NotFoundError, UnfetchableContentError } from "./errors.js";
import { HostValidationError } from "./host-validation.js";
import { FolderTrackingRejectedError, MirrorRepository } from "./repository.js";
import { MirrorEngine } from "./sync-engine.js";
import { sendMessage } from "./send.js";
import { searchMessages, type SearchRequest, type SearchResponse } from "./search/index.js";
import {
  cleanMessageBody,
  downloadAttachment,
  downloadAttachmentStream,
  getAttachmentMetadata,
  getMessageHeaders,
  getRawMime,
  listAttachments,
  selectFields,
  type AttachmentDownload,
  type AttachmentDownloadStream,
  type AttachmentInfo,
  type CleanBodyResultDetail,
  type MessageHeadersResult,
  type RawMimeResult
} from "./content.js";
import {
  createDraft,
  deleteDraft,
  getDraft,
  listDrafts,
  sendDraft,
  updateDraft,
  type CreateDraftResult,
  type DeleteDraftResult,
  type DraftDetail,
  type DraftInput,
  type DraftSummary,
  type SendDraftResult,
  type UpdateDraftResult
} from "./drafts.js";
import {
  createFolder,
  deleteFolder,
  deleteMessage,
  MailboxCapabilityError,
  MailboxConflictError,
  MailboxMutationError,
  moveMessage,
  moveThread,
  renameFolder,
  setMessageFlags,
  setThreadFlags,
  type DeleteResult,
  type FlagResult,
  type FolderMutationResult,
  type MoveResult,
  type ThreadFlagResult,
  type ThreadMoveResult
} from "./mailbox-mutations.js";
import type {
  AccountDetails,
  AccountSummary,
  ImapFolder,
  ImapMessage,
  SendRequest,
  SendResult,
  SyncResult,
  UpdateAccountSettingsInput
} from "./types.js";

interface ApiRepository {
  listAccounts(): Promise<AccountSummary[]>;
  createAccount(input: unknown): Promise<AccountSummary>;
  getAccount(id: string): Promise<unknown | null>;
  getAccountDetails(id: string): Promise<AccountDetails | null>;
  updateAccountSettings(accountId: string, input: UpdateAccountSettingsInput): Promise<AccountSummary | null>;
  trackFolder(accountId: string, path: string): Promise<ImapFolder | null>;
  getMessage(id: string): Promise<ImapMessage | null>;
}

interface ApiEngine {
  syncAccount(id: string, source: "api"): Promise<SyncResult>;
  fetchBody(id: string, force?: boolean): Promise<boolean>;
}

interface ApiAppOptions {
  apiToken: string | undefined;
  adminToken?: string | null;
  repository: ApiRepository;
  engine: ApiEngine;
  applyMigration: () => Promise<void>;
  /** Single-tenant send door (email-001). Resolves the SendResult JSON. */
  send: (req: SendRequest) => Promise<SendResult>;
  /** Read-only ranked search over the mirror (email-005, ADR 0015). Composes the
   *  semantic free-text query with structured field/state/date/folder filters. */
  search: (req: SearchRequest) => Promise<SearchResponse>;
  /** Draft CRUD (email-003, ADR 0019). Create/update/send APPEND to Drafts (and
   * delete-old where needed); list/get read the mirror. Drafts carry neither Bcc nor
   * attachments — neither can round-trip the saved bytes, so both are send-time-only
   * fields (see ADR 0019 / 0020). */
  drafts: {
    create: (req: DraftInput) => Promise<CreateDraftResult>;
    list: (accountId: string, options: { limit?: number }) => Promise<DraftSummary[]>;
    get: (messageId: string) => Promise<DraftDetail | null>;
    update: (messageId: string, input: Omit<SendRequest, "accountId" | "bcc" | "attachments">) => Promise<UpdateDraftResult>;
    send: (messageId: string) => Promise<SendDraftResult>;
    delete: (messageId: string, options: { hard?: boolean }) => Promise<DeleteDraftResult>;
  };
  /** Attachment + content read surface (email-004, ADR 0020). Attachment metadata,
   * clean bodies, and full/basic headers read the mirror; attachment-byte download
   * and raw MIME (under parsed_only) do an on-demand read-only IMAP fetch. */
  content: {
    listAttachments: (messageId: string) => Promise<AttachmentInfo[]>;
    getAttachmentMetadata: (attachmentId: string) => Promise<AttachmentInfo | null>;
    downloadAttachment: (attachmentId: string) => Promise<AttachmentDownload>;
    downloadAttachmentStream: (attachmentId: string) => Promise<AttachmentDownloadStream>;
    getRawMime: (messageId: string) => Promise<RawMimeResult>;
    getMessageHeaders: (messageId: string, options: { basic?: boolean }) => Promise<MessageHeadersResult>;
    cleanMessageBody: (messageId: string, options: { includeQuoted?: boolean; maxChars?: number }) => Promise<CleanBodyResultDetail>;
  };
  /** Organize mutations (email-002, ADR 0018). Each acts on IMAP by UID. */
  mutations: {
    setMessageFlags: (messageId: string, change: { add?: string[]; remove?: string[] }) => Promise<FlagResult>;
    moveMessage: (messageId: string, folder: string) => Promise<MoveResult>;
    deleteMessage: (messageId: string, options: { hard?: boolean }) => Promise<DeleteResult>;
    setThreadFlags: (messageId: string, change: { add?: string[]; remove?: string[] }) => Promise<ThreadFlagResult>;
    moveThread: (messageId: string, folder: string) => Promise<ThreadMoveResult>;
    createFolder: (accountId: string, path: string) => Promise<FolderMutationResult>;
    renameFolder: (accountId: string, path: string, newPath: string) => Promise<FolderMutationResult>;
    deleteFolder: (accountId: string, path: string) => Promise<FolderMutationResult>;
  };
}

interface StartApiServerOptions {
  config?: AppConfig;
  pool?: PgPool;
  repository?: MirrorRepository;
  engine?: MirrorEngine;
}

const UUID_SCHEMA = z.string().uuid();

const CREATE_ACCOUNT_SCHEMA = z.object({
  emailAddress: z.string().email().max(255),
  // host/port are optional: when omitted, connect-time autodiscovery fills them
  // from the email domain's provider preset (email-008). Explicit values win.
  host: z.string().min(1).max(255).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(1024),
  smtpHost: z.string().min(1).max(255).optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  smtpUsername: z.string().min(1).max(255).optional(),
  smtpPassword: z.string().min(1).max(1024).optional(),
  providerProfile: z.string().min(1).max(64).optional(),
  bodyFetchPolicy: z.enum(["immediate", "lazy", "priority_then_backfill"]).optional()
});

const SEND_RECIPIENT_SCHEMA = z.object({
  email: z.string().email().max(255),
  name: z.string().max(255).optional()
});

// A header-safe string: no CR/LF, so a value can never break out of its header
// line and inject extra headers when it reaches the MIME composer. nodemailer 9
// strips newlines today, but we reject at the edge so the wire-byte safety is
// not solely external (defense in depth; see the review CRLF finding).
const NO_CRLF = (v: string) => !/[\r\n]/.test(v);
const CRLF_MSG = "must not contain CR or LF characters";
const headerSafe = (max: number) => z.string().max(max).refine(NO_CRLF, CRLF_MSG);
// A record whose values are all header-safe (custom headers).
const HEADER_RECORD = z.record(z.string().refine(NO_CRLF, CRLF_MSG));

// Cap a single base64 attachment payload at ~25MB of decoded bytes (the same
// BODY_RAW_MAX_BYTES ceiling reads use); base64 inflates ~4/3, so ~34MB encoded.
const MAX_ATTACHMENT_BASE64_LEN = 34 * 1024 * 1024;

// Whole-request ceiling for BOTH send transports (JSON base64 + multipart). This
// is enforced by a Hono bodyLimit BEFORE the body is buffered by parseBody/json(),
// so an oversized request is rejected with 413 without first materializing
// hundreds of MB on the single shared Node process (the OOM the review flagged).
// One attachment under MAX_ATTACHMENT_BASE64_LEN (~34MB) plus envelope fits; this
// bounds the aggregate, not each part. JSON (the default) is the worst case.
const MAX_SEND_BODY_BYTES = 35 * 1024 * 1024;

// One outbound attachment (email-004). `content` is base64 of the raw bytes; `cid`
// makes it an inline image referenced from the HTML body as `cid:<value>`.
const ATTACHMENT_SCHEMA = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().max(255).optional(),
  content: z.string().max(MAX_ATTACHMENT_BASE64_LEN),
  cid: z.string().max(255).optional(),
  inline: z.boolean().optional()
});

// Send body minus accountId (taken from the path). Mirrors SendRequest.
const SEND_SCHEMA = z.object({
  to: z.array(SEND_RECIPIENT_SCHEMA).min(1),
  cc: z.array(SEND_RECIPIENT_SCHEMA).optional(),
  bcc: z.array(SEND_RECIPIENT_SCHEMA).optional(),
  subject: z.string().max(2000),
  body: z.object({
    format: z.enum(["plain", "html"]),
    text: z.string().optional(),
    html: z.string().optional()
  }),
  headers: HEADER_RECORD.optional(),
  inReplyTo: headerSafe(2000).optional(),
  references: headerSafe(8000).optional(),
  messageId: headerSafe(2000).optional(),
  attachments: z.array(ATTACHMENT_SCHEMA).max(32).optional()
});

// Draft body (email-003). Unlike SEND_SCHEMA, `to` may be empty/absent — a draft
// can be saved while still incomplete; the recipient requirement is enforced only
// when the draft is sent. accountId comes from the path on create.
//
// Bcc is intentionally NOT a draft field: it cannot round-trip through the APPENDed
// draft bytes (nodemailer's keepBcc default omits Bcc from the composed MIME), so a
// Bcc set on a saved draft would be silently dropped and never sent. We REJECT it
// here with a clear message rather than accept-and-drop. Bcc is a send-time-only
// field — set it on the /accounts/:id/send envelope (see ADR 0019).
//
// Attachments are likewise NOT a draft field: createDraft/updateDraft compose the
// saved bytes via `buildRawMime` from a draft input that carries no attachment
// bytes, so any attachment passed here would be silently dropped from the SAVED
// draft. We REJECT it here, exactly like Bcc — attachments are a send-time-only
// field; attach files on the /accounts/:id/send envelope (see ADR 0020). (sendDraft
// now resends the draft's RAW bytes — ADR 0019 addendum — so this is a save-time
// limitation, not a send-time loss.)
const DRAFT_SCHEMA = z.object({
  to: z.array(SEND_RECIPIENT_SCHEMA).optional(),
  cc: z.array(SEND_RECIPIENT_SCHEMA).optional(),
  bcc: z.any().optional().refine((v) => v === undefined, {
    message: "Bcc is not supported on saved drafts — set Bcc when you send the draft"
  }),
  subject: z.string().max(2000).optional(),
  body: z.object({
    format: z.enum(["plain", "html"]),
    text: z.string().optional(),
    html: z.string().optional()
  }),
  headers: HEADER_RECORD.optional(),
  inReplyTo: headerSafe(2000).optional(),
  references: headerSafe(8000).optional(),
  messageId: headerSafe(2000).optional(),
  attachments: z.any().optional().refine((v) => v === undefined, {
    message: "Attachments are not supported on saved drafts — attach files when you send the draft"
  })
});

const TRACK_FOLDER_SCHEMA = z.object({
  path: z.string().min(1).max(1024)
});

// Read-only search (email-005, ADR 0015). Query params arrive as strings, so the
// booleans/ints are coerced. Field/state/date/folder filters are collected into the
// structured `filters` object so they COMPOSE with the free-text `q` (semantic +
// fuzzy) rather than replace it. Empty/absent params become a no-op (omitted).
const BOOL_PARAM = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");
const WINDOW_ENUM = z.enum(["IN_WINDOW", "EXPIRED", "HISTORICAL"]);
const SEARCH_QUERY_SCHEMA = z.object({
  q: z.string().max(4096).optional(),
  from: z.string().max(255).optional(),
  to: z.string().max(255).optional(),
  cc: z.string().max(255).optional(),
  bcc: z.string().max(255).optional(),
  any_email: z.string().max(255).optional(),
  subject: z.string().max(2000).optional(),
  body: z.string().max(2000).optional(),
  folder: z.string().max(1024).optional(),
  thread: z.string().max(512).optional(),
  unread: BOOL_PARAM.optional(),
  starred: BOOL_PARAM.optional(),
  has_attachment: BOOL_PARAM.optional(),
  received_after: z.string().max(64).optional(),
  received_before: z.string().max(64).optional(),
  account: z.string().uuid().optional(),
  window: WINDOW_ENUM.optional(),
  sort: z.enum(["smart", "relevance", "recent", "oldest", "size", "sender"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // Cap offset: deep OFFSET in the no-candidate-cap structured path scans/scores/
  // discards every prior row (bounded only by statement_timeout). A few thousand
  // is far past any real "page through results" use; beyond it, narrow with
  // filters instead. (Keyset pagination is the longer-term fix — see ADR 0015.)
  offset: z.coerce.number().int().min(0).max(5000).optional(),
  include_body: BOOL_PARAM.optional(),
  include_deleted: BOOL_PARAM.optional()
});

// Organize mutations (email-002). A flag token is a SupaMail short name
// (seen/flagged/…), a bare keyword, or a `\`-prefixed system flag. At least one
// of add/remove must be present. Charset is constrained to a single optional
// optional single leading \ or $ + alphanumerics/$/underscore/hyphen so a token
// like `\Junk Foo` or one carrying control chars can never reach imapflow's STORE,
// while legitimate custom IMAP keywords ($Forwarded, $MDNSent, $label1 — RFC 5788)
// still pass (toImapFlag's contract: unknown tokens pass through verbatim).
const FLAG_TOKEN = z.string().min(1).max(64).regex(/^[\\$]?[A-Za-z0-9$_-]+$/, {
  message: "Flag token must be an optional leading \\ or $ then letters, digits, $, underscore, or hyphen"
});
const FLAGS_SCHEMA = z.object({
  add: z.array(FLAG_TOKEN).max(16).optional(),
  remove: z.array(FLAG_TOKEN).max(16).optional()
}).refine((v) => (v.add?.length ?? 0) + (v.remove?.length ?? 0) > 0, {
  message: "At least one flag in add or remove is required"
});

const MOVE_SCHEMA = z.object({
  folder: z.string().min(1).max(1024)
});

const FOLDER_PATH_SCHEMA = z.object({
  path: z.string().min(1).max(1024)
});

const RENAME_FOLDER_SCHEMA = z.object({
  path: z.string().min(1).max(1024),
  newPath: z.string().min(1).max(1024)
});

const MUTABLE_ACCOUNT_SETTING_KEYS = [
  "historicalBackfillMode",
  "archiveRefreshInterval",
  "archiveFlagSync",
  "maxBackfillRate"
] as const;

const ACCOUNT_SETTINGS_SCHEMA = z.object({
  historicalBackfillMode: z.enum(["off", "metadata_only", "metadata_and_bodies"]).optional(),
  archiveRefreshInterval: z.enum(["never", "monthly", "weekly"]).optional(),
  archiveFlagSync: z.boolean().optional(),
  maxBackfillRate: z.enum(["small", "normal", "aggressive"]).optional(),
  liveWindowDays: z.unknown().optional(),
  live_window_days: z.unknown().optional()
}).strict().superRefine((input, ctx) => {
  const immutablePath = "liveWindowDays" in input ? "liveWindowDays" : "live_window_days" in input ? "live_window_days" : null;
  if (immutablePath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [immutablePath],
      message: "live_window_days is immutable after account creation"
    });
  }

  if (!MUTABLE_ACCOUNT_SETTING_KEYS.some((key) => input[key] !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "At least one mutable account setting is required"
    });
  }
});

async function parseJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HTTPException(400, { res: c.json({ error: "invalid_json" }, 400) });
  }
}

// Cap one uploaded file part (decoded bytes) at the same ~25MB read ceiling.
const MAX_MULTIPART_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Parse a multipart/form-data send (email-004). The `payload` field carries the
 * JSON send envelope (to/subject/body/…); every File field is decoded to base64
 * and appended as an attachment (filename + contentType from the part, marked
 * inline when the field name is `inline`). Returns the merged object for
 * SEND_SCHEMA. A file over the size cap is rejected with 413.
 */
async function parseMultipartSend(c: Context): Promise<unknown> {
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch {
    throw new HTTPException(400, { res: c.json({ error: "invalid_multipart" }, 400) });
  }

  const payloadRaw = body.payload;
  let envelope: Record<string, unknown> = {};
  if (typeof payloadRaw === "string" && payloadRaw.trim().length > 0) {
    try {
      envelope = JSON.parse(payloadRaw) as Record<string, unknown>;
    } catch {
      throw new HTTPException(400, { res: c.json({ error: "invalid_json", field: "payload" }, 400) });
    }
  }

  const attachments: Array<{ filename: string; contentType?: string; content: string; inline?: boolean }> = [];
  for (const [field, value] of Object.entries(body)) {
    const parts = Array.isArray(value) ? value : [value];
    for (const part of parts) {
      if (!(part instanceof File)) continue;
      const bytes = Buffer.from(await part.arrayBuffer());
      if (bytes.length > MAX_MULTIPART_FILE_BYTES) {
        throw new HTTPException(413, { res: c.json({ error: "attachment_too_large", filename: part.name }, 413) });
      }
      attachments.push({
        filename: part.name || field,
        contentType: part.type || undefined,
        content: bytes.toString("base64"),
        inline: field.toLowerCase() === "inline" ? true : undefined
      });
    }
  }

  // Merge with any base64 attachments already present in the JSON envelope.
  const existing = Array.isArray(envelope.attachments) ? envelope.attachments : [];
  if (attachments.length > 0 || existing.length > 0) {
    envelope.attachments = [...existing, ...attachments];
  }
  return envelope;
}

/** Parse a `?fields=a,b,c` query into a key list (field selection). */
function parseFields(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const fields = raw.split(",").map((f) => f.trim()).filter(Boolean);
  return fields.length > 0 ? fields : undefined;
}

/**
 * Convert a Node Buffer to the exact ArrayBuffer slice it views, for Hono's
 * `c.body()`. Node Buffers are often views into a larger pooled ArrayBuffer, so
 * slice by byteOffset/byteLength to return only this buffer's bytes.
 */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Build a safe `Content-Disposition` header for an attacker-influenced filename.
 * The ASCII `filename=` token is stripped of CR/LF/`"`/`;`/`\`/control chars so it
 * cannot break out of the quoted-string or inject extra disposition params, and an
 * RFC 5987 `filename*=UTF-8''<percent-encoded>` token carries the original
 * (possibly non-ASCII) name losslessly. A user agent that understands `filename*`
 * prefers it; the sanitized ASCII `filename` is the safe fallback.
 */
function contentDispositionHeader(disposition: "inline" | "attachment", filename: string): string {
  const asciiFallback = filename.replace(/[\r\n";\\\x00-\x1f\x7f]/g, "").trim() || "attachment";
  // RFC 5987: percent-encode everything outside the attr-char set.
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function safeBearerEquals(received: string, expected: Buffer): boolean {
  const buf = Buffer.from(received, "utf8");
  if (buf.length !== expected.length) return false;
  return timingSafeEqual(buf, expected);
}

export function createApiApp(options: ApiAppOptions): Hono {
  if (!options.apiToken) {
    throw new Error("API_TOKEN is required to run the SupaMail API");
  }

  const app = new Hono();
  const apiTokenBuffer = Buffer.from(`Bearer ${options.apiToken}`, "utf8");
  const adminTokenBuffer = options.adminToken
    ? Buffer.from(`Bearer ${options.adminToken}`, "utf8")
    : null;

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof HostValidationError) {
      return c.json({ error: err.code, message: err.message }, 400);
    }
    if (err instanceof NotFoundError) {
      return c.json({ error: "not_found", message: err.message }, 404);
    }
    if (err instanceof NoRecipientsError) {
      // A send/send-draft with no deliverable recipient — a malformed request,
      // not a server fault. 400, not 500.
      return c.json({ error: "no_recipients", message: err.message }, 400);
    }
    if (err instanceof UnfetchableContentError) {
      // Content known in metadata but not fetchable (e.g. an attachment row with
      // no BODYSTRUCTURE part number). A permanent condition: 422, not 500.
      return c.json({ error: "content_unfetchable", message: err.message }, 422);
    }
    if (err instanceof AccountBusyError) {
      // The per-account advisory lock is held (the sync worker is mid-cycle). The
      // request was well-formed; it just can't run concurrently. 503 + Retry-After,
      // not a 500 — the client should retry shortly.
      c.header("Retry-After", "5");
      return c.json({ error: "account_busy", message: err.message }, 503);
    }
    if (err instanceof FolderTrackingRejectedError) {
      return c.json({ error: err.code, message: err.message }, 400);
    }
    if (err instanceof MailboxConflictError) {
      // UIDVALIDITY moved underneath us — the request was well-formed, the server
      // state changed. 409 Conflict, not 500.
      return c.json({ error: "mailbox_conflict", message: err.message }, 409);
    }
    if (err instanceof MailboxCapabilityError) {
      // The IMAP server can't perform this verb safely (no UIDPLUS/MOVE — the
      // long-tail providers this product targets). A permanent refusal, not a
      // transient fault: 422 Unprocessable Entity with the actionable message,
      // not a 500 that invites a retry.
      return c.json({ error: "capability_unsupported", message: err.message }, 422);
    }
    if (err instanceof MailboxMutationError) {
      // A STORE/MOVE/EXPUNGE returned a server-side failure (imapflow signals
      // these as false/empty). The upstream IMAP server failed to apply the
      // verb — 502 Bad Gateway, not a generic 500.
      return c.json({ error: "mailbox_mutation_failed", message: err.message }, 502);
    }
    if (err instanceof z.ZodError) {
      return c.json({ error: "invalid_input", issues: err.issues }, 400);
    }
    const pgCode = (err as { code?: string }).code;
    if (pgCode === "23505") {
      return c.json({ error: "conflict", message: "Resource already exists" }, 409);
    }
    console.error(JSON.stringify({
      event: "api.unhandled_error",
      error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
    }));
    return c.json({ error: "internal_error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, service: "supamail" }));

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    const header = c.req.header("authorization") ?? "";

    if (c.req.path === "/migrate") {
      const expected = adminTokenBuffer ?? apiTokenBuffer;
      if (!safeBearerEquals(header, expected)) {
        return c.json({ error: "unauthorized" }, 401);
      }
      return next();
    }

    if (!safeBearerEquals(header, apiTokenBuffer)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.post("/migrate", async (c) => {
    await options.applyMigration();
    return c.json({ ok: true });
  });

  app.get("/accounts", async (c) => {
    const accounts = await options.repository.listAccounts();
    return c.json({ accounts });
  });

  app.get("/accounts/:id", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const account = await options.repository.getAccountDetails(id);
    if (!account) throw new NotFoundError(`Account not found: ${id}`);
    return c.json({ account });
  });

  app.post("/accounts", async (c) => {
    const raw = await parseJsonBody(c);
    const input = CREATE_ACCOUNT_SCHEMA.parse(raw);
    const account = await options.repository.createAccount(input);
    return c.json({ account }, 201);
  });

  app.post("/accounts/:id/sync", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const account = await options.repository.getAccount(id);
    if (!account) throw new NotFoundError(`Account not found: ${id}`);
    const result = await options.engine.syncAccount(id, "api");
    return c.json({ result });
  });

  app.post("/accounts/:id/folders/track", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const account = await options.repository.getAccount(id);
    if (!account) throw new NotFoundError(`Account not found: ${id}`);
    const raw = await parseJsonBody(c);
    const input = TRACK_FOLDER_SCHEMA.parse(raw);
    const folder = await options.repository.trackFolder(id, input.path);
    if (!folder) throw new NotFoundError(`Folder not found: ${input.path}`);
    return c.json({ folder });
  });

  app.patch("/accounts/:id/settings", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const account = await options.repository.getAccount(id);
    if (!account) throw new NotFoundError(`Account not found: ${id}`);
    const raw = await parseJsonBody(c);
    const parsed = ACCOUNT_SETTINGS_SCHEMA.parse(raw);
    const input: UpdateAccountSettingsInput = {
      historicalBackfillMode: parsed.historicalBackfillMode,
      archiveRefreshInterval: parsed.archiveRefreshInterval,
      archiveFlagSync: parsed.archiveFlagSync,
      maxBackfillRate: parsed.maxBackfillRate
    };
    const updated = await options.repository.updateAccountSettings(id, input);
    if (!updated) throw new NotFoundError(`Account not found: ${id}`);
    return c.json({ account: updated });
  });

  app.post("/messages/:id/refetch-body", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const message = await options.repository.getMessage(id);
    if (!message) throw new NotFoundError(`Message not found: ${id}`);
    const fetched = await options.engine.fetchBody(id, true);
    return c.json({ fetched });
  });

  // Read-only ranked search over the mirror (email-005, ADR 0015). Structured
  // field/state/date/folder filters are GET query params that COMPOSE with the
  // semantic + fuzzy free-text `q` (e.g. ?q=invoice&from=acme.com&unread=true&
  // received_after=2026-01-01&folder=INBOX). Every value is bound; nothing is
  // interpolated. Absent params are omitted (no-op). Pagination via limit/offset.
  app.get("/search", async (c) => {
    const p = SEARCH_QUERY_SCHEMA.parse(
      Object.fromEntries(new URL(c.req.url).searchParams.entries())
    );
    const filters: NonNullable<SearchRequest["filters"]> = {};
    if (p.from !== undefined) filters.from = p.from;
    if (p.to !== undefined) filters.to = p.to;
    if (p.cc !== undefined) filters.cc = p.cc;
    if (p.bcc !== undefined) filters.bcc = p.bcc;
    if (p.any_email !== undefined) filters.anyEmail = p.any_email;
    if (p.subject !== undefined) filters.subject = p.subject;
    if (p.body !== undefined) filters.body = p.body;
    if (p.folder !== undefined) filters.folder = p.folder;
    if (p.thread !== undefined) filters.thread = p.thread;
    if (p.unread !== undefined) filters.isUnread = p.unread;
    if (p.starred !== undefined) filters.isStarred = p.starred;
    if (p.has_attachment !== undefined) filters.hasAttachment = p.has_attachment;
    if (p.received_after !== undefined) filters.after = p.received_after;
    if (p.received_before !== undefined) filters.before = p.received_before;
    if (p.window !== undefined) filters.window = p.window;

    const request: SearchRequest = {
      // Treat an empty/whitespace `?q=` as absent so it doesn't slip past the
      // "provide q and/or a filter" guard below into an unfiltered recent scan.
      q: p.q?.trim() ? p.q : undefined,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      accounts: p.account ? [p.account] : undefined,
      sort: p.sort,
      limit: p.limit,
      offset: p.offset,
      includeBody: p.include_body,
      includeDeleted: p.include_deleted
    };
    // Either q or at least one filter must be present (mirrors the MCP/CLI contract).
    if (request.q === undefined && request.filters === undefined) {
      throw new HTTPException(400, {
        res: c.json({ error: "invalid_input", message: "Provide a query (q) and/or at least one filter." }, 400)
      });
    }
    const response = await options.search(request);
    return c.json(response);
  });

  // Attachment + content reads (email-004, ADR 0020). Metadata / clean body /
  // headers read the mirror; attachment-byte download + raw MIME (parsed_only) do
  // an on-demand read-only IMAP fetch. `?fields=` shrinks JSON payloads.
  app.get("/messages/:id/attachments", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const message = await options.repository.getMessage(id);
    if (!message) throw new NotFoundError(`Message not found: ${id}`);
    const fields = parseFields(c.req.query("fields"));
    const attachments = (await options.content.listAttachments(id)).map((a) => selectFields(a, fields));
    return c.json({ attachments });
  });

  app.get("/attachments/:id/metadata", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const meta = await options.content.getAttachmentMetadata(id);
    if (!meta) throw new NotFoundError(`Attachment not found: ${id}`);
    return c.json({ attachment: selectFields(meta, parseFields(c.req.query("fields"))) });
  });

  // Stream the decoded attachment bytes (always an on-demand IMAP fetch). The bytes are
  // never buffered in full — the part streams straight from the IMAP socket, so peak
  // memory stays flat regardless of file size. Preflight (404/422/UIDVALIDITY) throws
  // BEFORE the stream, so the status is settled before headers are sent; the stream owns
  // its own teardown (auto-close on end/error, and on client abort the web-stream cancel
  // destroys the source → releases the IMAP lock + connection).
  app.get("/attachments/:id/download", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const download = await options.content.downloadAttachmentStream(id);
    c.header("content-type", download.contentType ?? "application/octet-stream");
    c.header(
      "content-disposition",
      contentDispositionHeader(download.inline ? "inline" : "attachment", download.filename ?? "attachment")
    );
    return c.body(Readable.toWeb(download.stream) as unknown as ReadableStream);
  });

  app.get("/messages/:id/raw", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const message = await options.repository.getMessage(id);
    if (!message) throw new NotFoundError(`Message not found: ${id}`);
    const raw = await options.content.getRawMime(id);
    c.header("content-type", "message/rfc822");
    c.header("x-supamail-raw-source", raw.source);
    return c.body(toArrayBuffer(raw.raw));
  });

  app.get("/messages/:id/headers", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const message = await options.repository.getMessage(id);
    if (!message) throw new NotFoundError(`Message not found: ${id}`);
    const basic = c.req.query("basic") === "true" || c.req.query("basic") === "1";
    const result = await options.content.getMessageHeaders(id, { basic });
    return c.json({ headers: result.headers, source: result.source });
  });

  app.get("/messages/:id/clean-body", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const message = await options.repository.getMessage(id);
    if (!message) throw new NotFoundError(`Message not found: ${id}`);
    const includeQuoted = c.req.query("include_quoted") === "true" || c.req.query("include_quoted") === "1";
    const maxCharsRaw = c.req.query("max_chars");
    // A non-numeric `?max_chars=abc` yields NaN, which would silently disable
    // truncation; fall back to the default (undefined) on anything non-finite.
    const maxCharsParsed = maxCharsRaw ? Number(maxCharsRaw) : undefined;
    const maxChars = Number.isFinite(maxCharsParsed) ? maxCharsParsed : undefined;
    const result = await options.content.cleanMessageBody(id, { includeQuoted, maxChars });
    return c.json({ body: result.body, truncated: result.truncated });
  });

  // Bound the WHOLE send request before any buffering (bodyLimit reads
  // Content-Length / streams with a cap and 413s past MAX_SEND_BODY_BYTES),
  // covering BOTH the JSON base64 and multipart transports so neither can OOM the
  // shared Node process by buffering hundreds of MB ahead of the per-part checks.
  const sendBodyLimit = bodyLimit({
    maxSize: MAX_SEND_BODY_BYTES,
    onError: (c) => c.json({ error: "request_too_large" }, 413)
  });

  app.post("/accounts/:id/send", sendBodyLimit, async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const account = await options.repository.getAccount(id);
    if (!account) throw new NotFoundError(`Account not found: ${id}`);
    // Two transports for attachments (email-004): a JSON body with base64
    // `attachments`, or a size-capped multipart/form-data upload whose `payload`
    // part carries the JSON envelope and whose file parts become attachments.
    const contentType = c.req.header("content-type") ?? "";
    const raw = contentType.includes("multipart/form-data")
      ? await parseMultipartSend(c)
      : await parseJsonBody(c);
    const input = SEND_SCHEMA.parse(raw);
    const result = await options.send({ accountId: id, ...input });
    return c.json({ result });
  });

  // Draft CRUD (email-003, ADR 0019). Create files a `\Draft` APPEND to the
  // account's Drafts folder; list/get read the mirror; update is APPEND-new +
  // delete-old; send-draft reuses the email-001 send path then deletes the draft.
  app.post("/accounts/:id/drafts", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const account = await options.repository.getAccount(id);
    if (!account) throw new NotFoundError(`Account not found: ${id}`);
    const input = DRAFT_SCHEMA.parse(await parseJsonBody(c));
    // Optional idempotent create: a retry carrying the same Idempotency-Key returns the
    // existing draft instead of filing a duplicate (search-before-APPEND in createDraft).
    // Normalize blank/whitespace to "no key" so "" and "   " behave identically
    // (both fall back to a non-idempotent APPEND) instead of "" silently duping while
    // "   " derives a useless Message-ID.
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim() || undefined;
    const result = await options.drafts.create({
      accountId: id,
      ...input,
      to: input.to ?? [],
      subject: input.subject ?? "",
      idempotencyKey
    });
    return c.json({ result }, 201);
  });

  app.get("/accounts/:id/drafts", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const account = await options.repository.getAccount(id);
    if (!account) throw new NotFoundError(`Account not found: ${id}`);
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const drafts = await options.drafts.list(id, { limit });
    return c.json({ drafts });
  });

  app.get("/drafts/:id", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const draft = await options.drafts.get(id);
    if (!draft) throw new NotFoundError(`Draft not found: ${id}`);
    return c.json({ draft });
  });

  app.patch("/drafts/:id", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const input = DRAFT_SCHEMA.parse(await parseJsonBody(c));
    const result = await options.drafts.update(id, { ...input, to: input.to ?? [], subject: input.subject ?? "" });
    return c.json({ result });
  });

  app.post("/drafts/:id/send", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const result = await options.drafts.send(id);
    return c.json({ result });
  });

  app.delete("/drafts/:id", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const hard = c.req.query("hard") === "true" || c.req.query("hard") === "1";
    const result = await options.drafts.delete(id, { hard });
    return c.json({ result });
  });

  // Organize mutations (email-002, ADR 0018). Message-scoped routes resolve the
  // message → its account → act on IMAP by UID; the mirror reconciles on the next
  // sync. Folder CRUD is account-scoped.
  app.post("/messages/:id/flags", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const message = await options.repository.getMessage(id);
    if (!message) throw new NotFoundError(`Message not found: ${id}`);
    const input = FLAGS_SCHEMA.parse(await parseJsonBody(c));
    const result = await options.mutations.setMessageFlags(id, input);
    return c.json({ result });
  });

  app.post("/messages/:id/move", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const message = await options.repository.getMessage(id);
    if (!message) throw new NotFoundError(`Message not found: ${id}`);
    const input = MOVE_SCHEMA.parse(await parseJsonBody(c));
    const result = await options.mutations.moveMessage(id, input.folder);
    return c.json({ result });
  });

  app.delete("/messages/:id", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const message = await options.repository.getMessage(id);
    if (!message) throw new NotFoundError(`Message not found: ${id}`);
    const hard = c.req.query("hard") === "true" || c.req.query("hard") === "1";
    const result = await options.mutations.deleteMessage(id, { hard });
    return c.json({ result });
  });

  app.post("/threads/:id/flags", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const message = await options.repository.getMessage(id);
    if (!message) throw new NotFoundError(`Message not found: ${id}`);
    const input = FLAGS_SCHEMA.parse(await parseJsonBody(c));
    const result = await options.mutations.setThreadFlags(id, input);
    return c.json({ result });
  });

  app.post("/threads/:id/move", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const message = await options.repository.getMessage(id);
    if (!message) throw new NotFoundError(`Message not found: ${id}`);
    const input = MOVE_SCHEMA.parse(await parseJsonBody(c));
    const result = await options.mutations.moveThread(id, input.folder);
    return c.json({ result });
  });

  app.post("/accounts/:id/folders", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const account = await options.repository.getAccount(id);
    if (!account) throw new NotFoundError(`Account not found: ${id}`);
    const input = FOLDER_PATH_SCHEMA.parse(await parseJsonBody(c));
    const result = await options.mutations.createFolder(id, input.path);
    return c.json({ result }, 201);
  });

  app.patch("/accounts/:id/folders", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const account = await options.repository.getAccount(id);
    if (!account) throw new NotFoundError(`Account not found: ${id}`);
    const input = RENAME_FOLDER_SCHEMA.parse(await parseJsonBody(c));
    const result = await options.mutations.renameFolder(id, input.path, input.newPath);
    return c.json({ result });
  });

  app.delete("/accounts/:id/folders", async (c) => {
    const id = UUID_SCHEMA.parse(c.req.param("id"));
    const account = await options.repository.getAccount(id);
    if (!account) throw new NotFoundError(`Account not found: ${id}`);
    const input = FOLDER_PATH_SCHEMA.parse(await parseJsonBody(c));
    const result = await options.mutations.deleteFolder(id, input.path);
    return c.json({ result });
  });

  return app;
}

export function startApiServer(options: StartApiServerOptions = {}): ReturnType<typeof serve> {
  const config = options.config ?? getConfig();
  const pool = options.pool ?? getPool();
  const repository = options.repository ?? new MirrorRepository(pool, config);
  const engine = options.engine ?? new MirrorEngine({ pool, config, repository });
  const app = createApiApp({
    apiToken: config.API_TOKEN,
    adminToken: config.ADMIN_TOKEN,
    repository,
    engine,
    applyMigration: () => applyPublicMigrations(pool),
    send: (req) => sendMessage(pool, config, req),
    search: (req) => searchMessages(pool, req),
    drafts: {
      create: (req) => createDraft(pool, config, req),
      list: (accountId, opts) => listDrafts(pool, config, accountId, opts),
      get: (messageId) => getDraft(pool, config, messageId),
      update: (messageId, input) => updateDraft(pool, config, messageId, input),
      send: (messageId) => sendDraft(pool, config, messageId),
      delete: (messageId, opts) => deleteDraft(pool, config, messageId, opts)
    },
    content: {
      listAttachments: (messageId) => listAttachments(pool, config, messageId),
      getAttachmentMetadata: (attachmentId) => getAttachmentMetadata(pool, config, attachmentId),
      downloadAttachment: (attachmentId) => downloadAttachment(pool, config, attachmentId),
      downloadAttachmentStream: (attachmentId) => downloadAttachmentStream(pool, config, attachmentId),
      getRawMime: (messageId) => getRawMime(pool, config, messageId),
      getMessageHeaders: (messageId, opts) => getMessageHeaders(pool, config, messageId, opts),
      cleanMessageBody: (messageId, opts) => cleanMessageBody(pool, config, messageId, opts)
    },
    mutations: {
      setMessageFlags: (messageId, change) => setMessageFlags(pool, config, messageId, change),
      moveMessage: (messageId, folder) => moveMessage(pool, config, messageId, folder),
      deleteMessage: (messageId, opts) => deleteMessage(pool, config, messageId, opts),
      setThreadFlags: (messageId, change) => setThreadFlags(pool, config, messageId, change),
      moveThread: (messageId, folder) => moveThread(pool, config, messageId, folder),
      createFolder: (accountId, path) => createFolder(pool, config, accountId, path),
      renameFolder: (accountId, path, newPath) => renameFolder(pool, config, accountId, path, newPath),
      deleteFolder: (accountId, path) => deleteFolder(pool, config, accountId, path)
    }
  });

  const server = serve({ fetch: app.fetch, port: config.PORT });
  console.log(`SupaMail API listening on :${config.PORT}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startApiServer();
}
