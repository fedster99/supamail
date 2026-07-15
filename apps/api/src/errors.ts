/**
 * Shared typed errors for the act/read surfaces (send, drafts, content,
 * mutations). These are thrown by the lib functions (so the CLI sees the same
 * typed failures) and mapped to HTTP status codes by api.ts's `onError`. Keeping
 * them in one tiny module (no IMAP client, no write verb) means the zero-send
 * agent surface can import a thrower without pulling in a mutation path.
 *
 * Mapping (api.ts onError):
 *   NotFoundError            → 404 not_found
 *   NoRecipientsError        → 400 no_recipients
 *   UnfetchableContentError  → 422 content_unfetchable
 */

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
