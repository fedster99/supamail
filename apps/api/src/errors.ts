/**
 * Shared typed errors for the act/read surfaces (send, drafts, content,
 * mutations). These are thrown by the lib functions (so the CLI sees the same
 * typed failures) and mapped to HTTP status codes by api.ts's `onError`. Keeping
 * them in one tiny module (no IMAP client, no write verb) means the zero-send
 * agent surface can import a thrower without pulling in a mutation path.
 *
 * Mapping (api.ts onError):
 *   InvalidInputError        → 400 invalid_input
 *   NotFoundError            → 404 not_found
 *   NoRecipientsError        → 400 no_recipients
 *   UnfetchableContentError  → 422 content_unfetchable
 *   MailboxConflictError     → 409 mailbox_conflict
 */

import type { ZodError, ZodIssue } from "zod";

/** Why an input was rejected, as a fixed id a host can count without reading the
 * message. The vocabulary is small and independent of the validation library:
 * `missing` (a required field is absent), `type` (wrong JSON type), `value` (not
 * one of the accepted values), `unknown_key` (a field the operation does not
 * accept), `too_small`, `too_big`, `format` (a string that is not a uuid, address,
 * date or pattern), `constraint` (a rule across fields or on content). */
export const INPUT_ISSUE_RULES = [
  "missing", "type", "value", "unknown_key", "too_small", "too_big", "format", "constraint"
] as const;
export type InputIssueRule = (typeof INPUT_ISSUE_RULES)[number];

/** One rejected input. `path` names the rejected field as the schema declares it
 * (object keys and array indexes; the whole input is `[]`). It never carries
 * caller text, so a host may record it; the readable message stays in `message`. */
export interface InputIssue {
  rule: InputIssueRule;
  path: Array<string | number>;
}

/** The caller's input is malformed (wrong shape, invalid address or id, a field
 * the operation does not accept). A client error the caller must fix, never a
 * provider or server fault, so it is never retried. Mapped to 400. */
export class InvalidInputError extends Error {
  readonly code = "invalid_input";
  /** Why, as fixed ids. Empty only for a rule that no field owns. */
  readonly issues: readonly InputIssue[];

  constructor(message: string, issues: readonly InputIssue[] = []) {
    super(message);
    this.name = "InvalidInputError";
    this.issues = issues;
  }
}

/** The issues a rejection reports, readable or typed: the first five, in schema order. */
const reportedIssues = (error: ZodError): ZodIssue[] => error.issues.slice(0, 5);

/** One readable line per schema issue (`to.0.email: Invalid email`), joined with
 * "; " and capped at five, so hosts can show it as-is. */
export function formatZodIssues(error: ZodError): string {
  return reportedIssues(error)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "input"}: ${issue.message}`)
    .join("; ");
}

function issueRule(issue: ZodIssue): InputIssueRule {
  switch (issue.code) {
    case "invalid_type":
      if (issue.received === "undefined") return "missing";
      return issue.expected === "undefined" ? "unknown_key" : "type";
    case "unrecognized_keys":
      return "unknown_key";
    case "invalid_union": {
      // A union fails as its branches do. Every branch saw the same value: one
      // that received nothing means the field is absent; all wrong types mean a
      // wrong type; otherwise the value matched no accepted shape.
      const branches = issue.unionErrors.flatMap((error) => error.issues);
      if (branches.some((branch) => branch.code === "invalid_type" && branch.received === "undefined")) return "missing";
      if (branches.every((branch) => branch.code === "invalid_type")) return "type";
      return "value";
    }
    case "invalid_enum_value":
    case "invalid_literal":
    case "invalid_union_discriminator":
      return "value";
    case "too_small":
      return "too_small";
    case "too_big":
      return "too_big";
    case "invalid_string":
    case "invalid_date":
      return "format";
    default:
      return "constraint";
  }
}

/** The typed issues behind a schema failure: the same issues, order and cap as
 * {@link formatZodIssues}. An unrecognized key is reported at the object's path,
 * never by the caller's key. */
export function inputIssues(error: ZodError): InputIssue[] {
  return reportedIssues(error).map((issue) => ({ rule: issueRule(issue), path: [...issue.path] }));
}

/** A requested resource (message, draft, attachment, account) does not exist. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** A send/send-draft was attempted with no deliverable recipient — a client
 * error (the request is malformed), not a server fault. Mapped to 400. */
export class NoRecipientsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoRecipientsError";
  }
}

/**
 * The live mailbox can no longer be safely addressed by the UID we mirrored:
 * UIDVALIDITY changed, so the stale UID may now point at a different message.
 * Thrown by mutations and on-demand content fetches alike. Mapped to 409: the
 * request was well-formed, the server state moved underneath us.
 */
export class MailboxConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxConflictError";
  }
}

/** Content exists in the mirror metadata but cannot be fetched from the provider
 * (e.g. an attachment row with no BODYSTRUCTURE part number). A permanent
 * condition, not a transient fault — mapped to 422, not 500. */
export class UnfetchableContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnfetchableContentError";
  }
}

/** The per-account advisory lock is held (the sync worker is mid-cycle, or another
 * on-demand provider operation is running), so this write can't safely run right
 * now. A transient condition — the client should retry shortly. Mapped to 503
 * with Retry-After. */
export class AccountBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountBusyError";
  }
}

/** The caller's AbortSignal stopped a direct mailbox action (lost lease, shutdown,
 * client disconnect). `cause` is the signal's reason. No provider command starts
 * after the abort; a command that was in flight has an unknown provider outcome. */
export class AbortError extends Error {
  constructor(reason?: unknown) {
    super("Mailbox action aborted", { cause: reason });
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError(signal.reason);
}

/** Refuse to start `work` after abort, and report any failure that races an
 * abort as {@link AbortError}. Without a signal this is just `work()`. */
export async function runAbortable<T>(
  signal: AbortSignal | undefined,
  work: () => Promise<T>
): Promise<T> {
  throwIfAborted(signal);
  try {
    return await work();
  } catch (error) {
    if (signal?.aborted && !(error instanceof AbortError)) throw new AbortError(signal.reason);
    throw error;
  }
}
