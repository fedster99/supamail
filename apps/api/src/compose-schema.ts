import { z } from "zod";
import { InvalidInputError, formatZodIssues } from "./errors.js";

/**
 * The one schema for compose input (send, draft create, draft update). The HTTP
 * API parses request bodies with the `*_BODY_SCHEMA`s (accountId comes from the
 * path); `sendMessage`, `createDraft`, and `updateDraft` parse their whole input
 * with the engine schemas below, so every host gets the same typed
 * {@link InvalidInputError} for malformed input instead of a failure deep inside
 * composition or delivery.
 */

// A header-safe string: no CR/LF, so a value can never break out of its header
// line and inject extra headers when it reaches the MIME composer. nodemailer 9
// strips newlines today, but we reject at the edge so the wire-byte safety is
// not solely external (defense in depth; see the review CRLF finding).
const NO_CRLF = (v: string) => !/[\r\n]/.test(v);
const CRLF_MSG = "must not contain CR or LF characters";
const headerSafe = (max: number) => z.string().max(max).refine(NO_CRLF, CRLF_MSG);
// A record whose values are all header-safe (custom headers).
const HEADER_RECORD = z.record(z.string().refine(NO_CRLF, CRLF_MSG));

/** Longest accepted References value; reply composition trims its chain to fit. */
export const MAX_REFERENCES_LENGTH = 8000;

// One @ with no whitespace on either side. Deliberately looser than a full address
// grammar: replies reuse mirrored addresses (`list+tag=x@…`, internationalized
// mailboxes) that strict validators reject, and the provider has the final say.
const EMAIL = z.string().max(255).regex(/^[^\s@]+@[^\s@]+$/, "Invalid email");

const RECIPIENT_SCHEMA = z.object({
  email: EMAIL,
  name: z.string().max(255).optional()
});

// Cap a single base64 attachment payload at ~25MB of decoded bytes (the same
// BODY_RAW_MAX_BYTES ceiling reads use); base64 inflates ~4/3, so ~34MB encoded.
const MAX_ATTACHMENT_BASE64_LEN = 34 * 1024 * 1024;

// One outbound attachment (email-004), exactly `SendAttachment`. `content` is base64
// of the raw bytes; `cid` makes it an inline image referenced as `cid:<value>`.
const ATTACHMENT_SCHEMA = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().max(255).optional(),
  content: z.string().max(MAX_ATTACHMENT_BASE64_LEN),
  cid: z.string().max(255).optional(),
  inline: z.boolean().optional()
});

const COMPOSE_FIELDS = {
  body: z.object({
    format: z.enum(["plain", "html"]),
    text: z.string().optional(),
    html: z.string().optional()
  }),
  headers: HEADER_RECORD.optional(),
  inReplyTo: headerSafe(2000).optional(),
  references: headerSafe(MAX_REFERENCES_LENGTH).optional(),
  messageId: headerSafe(2000).optional(),
  attachments: z.array(ATTACHMENT_SCHEMA).max(32).optional()
};

/** A send request body without accountId (the HTTP API takes it from the path). */
export const SEND_BODY_SCHEMA = z.object({
  to: z.array(RECIPIENT_SCHEMA).min(1),
  cc: z.array(RECIPIENT_SCHEMA).optional(),
  bcc: z.array(RECIPIENT_SCHEMA).optional(),
  subject: z.string().max(2000),
  ...COMPOSE_FIELDS
});

// A draft body (email-003). Unlike a send, `to` and `subject` may be absent — a
// draft can be saved while still incomplete; the recipient requirement is enforced
// only when the draft is sent.
//
// Bcc is intentionally NOT a draft field: it cannot round-trip through the APPENDed
// draft bytes (nodemailer's keepBcc default omits Bcc from the composed MIME), so a
// Bcc set on a saved draft would be silently dropped and never sent. We REJECT it
// with a clear message rather than accept-and-drop. Bcc is a send-time-only field
// (see ADR 0019).
//
// Attachments use the same bounded base64 transport and MIME composer as direct
// sends. sendDraft later resends the saved raw MIME, preserving every part.
export const DRAFT_BODY_SCHEMA = z.object({
  to: z.array(RECIPIENT_SCHEMA).default([]),
  cc: z.array(RECIPIENT_SCHEMA).optional(),
  bcc: z.undefined({ message: "Bcc is not supported on saved drafts — set Bcc when you send the draft" }),
  subject: z.string().max(2000).default(""),
  ...COMPOSE_FIELDS
});

// Engine-only fields: the mailbox, and the display name the host's settings supply
// (buildRawMime enforces its single-line rule).
const ENGINE_FIELDS = {
  accountId: z.string().uuid(),
  senderName: z.string().optional()
};

/** `SendRequest`, as `sendMessage` accepts it. */
export const SEND_REQUEST_SCHEMA = SEND_BODY_SCHEMA.extend(ENGINE_FIELDS);

/** `DraftInput`, as `createDraft` accepts it. */
export const DRAFT_INPUT_SCHEMA = DRAFT_BODY_SCHEMA.extend({
  ...ENGINE_FIELDS,
  idempotencyKey: z.string().optional()
});

/** `Omit<DraftInput, "accountId">`, as `updateDraft` accepts it. */
export const DRAFT_UPDATE_SCHEMA = DRAFT_INPUT_SCHEMA.omit({ accountId: true });

/** Parse `input`, or throw {@link InvalidInputError} with a readable message. */
export function parseInput<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new InvalidInputError(formatZodIssues(parsed.error));
  return parsed.data;
}
