# ADR 0035: Malformed Caller Input Is A Typed, Readable Error

Status: Accepted

Date: 2026-10-05

## Context

Only the core HTTP API validated compose input. `sendMessage`, `createDraft`, and
`updateDraft` took an unvalidated `SendRequest` or `DraftInput`, so a host that
calls the library directly (a hosted REST API or MCP server) could pass
`to: "a@b.com"`, a string body, or a non-UUID `accountId`. That failed deep inside
composition with a `TypeError` or a Postgres cast error. `sendMessage` then wrapped
it as `SmtpDeliveryError("not_delivered")`, which tells a caller that the mail
server refused a retryable message, so an agent retried a request that could never
succeed. Draft Bcc, forged custom headers, and an invalid sender name threw plain
`Error`s. The on-demand content fetch threw a plain `Error` for a UIDVALIDITY
change, so hosts matched it by text. MCP read tools returned a ZodError's JSON
dump as the `invalid_input` message.

## Decision

- **One compose schema.** `compose-schema.ts` owns the send and draft schemas.
  The HTTP API parses bodies with `SEND_BODY_SCHEMA` and `DRAFT_BODY_SCHEMA`; the
  engine entry points parse their whole input with `SEND_REQUEST_SCHEMA`,
  `DRAFT_INPUT_SCHEMA`, and `DRAFT_UPDATE_SCHEMA`, which add `accountId` (UUID),
  `senderName`, and the draft `idempotencyKey`. Draft `to` and `subject` stay
  optional; Bcc on a draft stays rejected.
- **`InvalidInputError`** (`errors.ts`, `name` `"InvalidInputError"`, `code`
  `"invalid_input"`) is thrown for malformed input before any SMTP or IMAP
  command. Its message lists each problem as `path: reason`
  (`to.0.email: Invalid email`), joined with `"; "`. `sendMessage` rethrows it
  unchanged, never as `SmtpDeliveryError`. Forbidden custom headers and an invalid
  sender name, checked in `buildRawMime`, use the same error. The HTTP API maps
  it to 400 `{ error: "invalid_input", message }`. The package root exports it with
  the other typed errors.
- **An unknown mailbox is `NotFoundError`.** `sendMessage` and `createDraft`
  throw it for an `accountId` with no account, and `sendMessage` passes it
  through, so it is a 404 rather than a `not_delivered` delivery outcome.
- **Addresses are checked loosely**: one `@`, no whitespace, at most 255
  characters. Replies reuse mirrored addresses such as `list+tag=x@…` or
  internationalized mailboxes that a strict validator rejects; the provider keeps
  the final say. This also loosens the core HTTP API, which used Zod's `email()`.
- **`MailboxConflictError` moves to `errors.ts`** and is re-exported from
  `mailbox-mutations.ts`. The content fetch throws it for a UIDVALIDITY change, so
  it is a 409 like a mutation, not a 500. The sync adapter's internal
  UIDVALIDITY errors are unchanged: they are classified by sync, not by hosts.
- **MCP read tools** (`read_message`, `read_thread`, `list_folders`,
  `search_email`) format schema failures with the same `formatZodIssues`. Codes
  and hints are unchanged.
- **Reply References fit the send limit.** `draft_reply` trims a References chain
  longer than 8000 characters to its root and newest ids (RFC 5537 §3.4.4), so a
  reply to a long thread still passes send validation.

## Consequences

- Hosts match `error.name === "InvalidInputError"` and answer 400 with the message
  as-is; `MailboxConflictError` answers 409 for reads and writes alike.
- A well-typed caller is unaffected. A caller that relied on the engine ignoring
  malformed fields now gets `InvalidInputError`.
- The existing per-field limits (subject 2000, recipient name 255, 32 attachments)
  now also apply to library callers. A reply to a mirrored message whose subject
  or sender name exceeds them fails with a readable error instead of sending.

## Verification

- `send.test.ts`, `drafts.test.ts`: malformed input and draft Bcc throw
  `InvalidInputError` before any lock, SMTP, or APPEND; a request with every
  optional field still sends or saves.
- `api-safety.test.ts`: `InvalidInputError` → 400 `invalid_input` with message.
- `content.test.ts`: a fetch-path UIDVALIDITY change throws `MailboxConflictError`.
- `read-message.test.ts`, `read-thread.test.ts`: a bad id gives
  `message_id: Invalid uuid`.
- `mcp/shared.test.ts`: a long References chain keeps its root and newest ids.
