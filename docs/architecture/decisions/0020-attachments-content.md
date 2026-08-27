# ADR 0020: Attachment Bytes + Raw MIME Are On-Demand Reads; Metadata + Clean Bodies Come From the Mirror; Content Operations Stay Off the Agent Surface

Status: Accepted

Date: 2026-06-22

## Context

email-004 adds the Nylas content-parity surface: attachments on send/draft, attachment download + metadata, inline images (Content-ID), raw MIME, full/basic headers, payload field-selection, and deterministic clean bodies. Two pressures shape it:

1. **Storage reality.** The mirror stores attachment *metadata* (`imap_attachments`) and parsed bodies/headers, but under the production default `BODY_STORAGE_MODE=parsed_only` it stores **no** attachment bytes and **no** `raw_mime` (see the parsed-only body-storage decision). So byte-level reads cannot always come from the mirror.
2. **The sacred boundaries.** The agent MCP surface is the five read tools (ADR 0014) and stays zero-send/read-only (ADR 0017); the sync adapter (`ThrottledImapClient`) must never gain a write verb (ADR 0018). The server instructions also say the *agent* surface exposes attachment metadata only — never bytes.

## Decision

- **Compose half** rides email-001: `SendRequest.attachments` (filename/contentType/base64 content, optional `cid` + `inline`) flow through the existing `buildRawMime` (nodemailer MailComposer handles MIME + inline `cid`) on the **send** path — no new compose path.
- **Attachments use the same MIME composer for sends and saved drafts.** `createDraft`/`updateDraft` pass `SendAttachment[]` through `buildRawMime`, so the APPENDed draft owns the complete attachment parts. `sendDraft` resends those exact raw bytes. Bcc remains send-time-only because nodemailer's default intentionally omits it from saved MIME.
- **Content-Disposition is hardened against attacker-influenced filenames.** The attachment-download route sanitizes the ASCII `filename=` token (strips CR/LF/`"`/`;`/`\`/control chars so it can't break the quoted string or inject extra disposition params) and adds an RFC 5987 `filename*=UTF-8''<percent-encoded>` token so non-ASCII names round-trip losslessly.
- **Invalid `max_chars` falls back to the content-operation default.** A non-numeric `?max_chars=abc` / `--max-chars abc` yields `NaN`; the HTTP route and CLI guard with `Number.isFinite`, and `cleanMessageBody` applies its 4,096-character default.
- **Dedicated content operations live in a new `content.ts`, OUTSIDE `src/mcp/`**, reachable via the lib barrel + `API_TOKEN` HTTP routes + the CLI — **never as a sixth MCP tool** (so `agent-surface-zero-send.test.ts` stays unchanged and still asserts exactly five tools). Those existing operations remain bounded to 4,096 characters by default. MCP message/thread reads return the full available cleaned body from the mirror through the shared `cleanBody` helper.
- **Storage-aware read strategy:**
  - Attachment **metadata** → mirror (`imap_attachments`), cheap SELECT.
  - Attachment **bytes** → ALWAYS an on-demand IMAP part FETCH (never mirrored).
  - **Raw MIME** → mirror `raw_mime` when present (`raw_mime` mode), else on-demand whole-message FETCH (`parsed_only`).
  - **Headers** → mirror `headers_json` (+ body headers), with an on-demand FETCH+parse fallback only when nothing is stored.
  - **Clean body** → STORED body text only (no IMAP), reusing the deterministic `cleanBody` heuristic. By default it removes recognized one-line or wrapped `On … wrote:` tails, final quote-only blocks, and `-- ` signatures. It keeps Outlook and `Original Message` blocks because they can contain forwarded evidence. No LLM, no new dependency.
- On-demand fetches use a narrow read-only `ContentImapClient` exposing only `downloadPart()` / `downloadPartStream()` / `fetchOneSource()` — UIDVALIDITY-guarded so a server reset can never make us fetch a different message. It is **not** the sync adapter (`sync-adapter-read-only.test.ts` holds) and never writes; it reuses the frozen connect + `decryptPassword` + `assertSafeImapTarget` pattern. Update (ADR 0022): that "reused pattern" is now an actual shared function, `connectImap` (`imap-connect.ts`) — `ContentImapClient` obtains its socket there, and its UIDVALIDITY fail-closed check is the shared `uidValidityMatches`/`uidValidityMismatchMessage` co-located with the connector (the fetch path keeps its own plain `Error`); the download/fetch verb surface is unchanged.
- **Field selection** (`selectFields` / `?fields=` / `--fields`) is a pure top-level projection to shrink read payloads.

## Consequences

- Attachment download and (under `parsed_only`) raw MIME / header-fallback each cost one live IMAP round-trip — acceptable; they are explicit, on-demand reads, not hot-path sync.
- Update (streaming): attachment byte download now has a STREAMING variant, `downloadAttachmentStream()`, which returns imapflow's decoded part stream instead of buffering the whole part in memory (the `/attachments/:id/download` route pipes it), so peak memory stays flat regardless of file size. The buffered `downloadAttachment()` is kept (CLI + back-compat) and now delegates to the stream + `streamToBuffer`. Preflight (404 / 422 / UIDVALIDITY) still throws BEFORE any byte, so the HTTP status is settled before headers are sent; the caller owns a `close()` (idempotent, also auto-fired on stream `close`/`error`) that releases the folder lock + connection — the lock is now held for the stream's lifetime, bounded by the caller's own in-flight limit. `maxBytes` is an explicit arg (imapflow caps the DECODED stream), so a consumer can raise the per-download ceiling without touching `BODY_RAW_MAX_BYTES` (the sync-memory knob).
- The agent MCP surface is unchanged: attachment bytes, raw MIME, and dedicated header/content operations are operator/automation reads behind `API_TOKEN`, not agent tools. Attachment metadata and the full available cleaned body remain fields on the existing MCP read tools. A future agent must NOT add a sixth MCP content tool (it would break the five-tool assertion).
- `cleanBody` is deterministic text parsing reused from the shared read layer — it must stay model-free (the "no LLM inside the product" rule).
- Byte reads inherit the UIDVALIDITY guard, so a mailbox reset fails closed rather than returning the wrong part.
- Draft attachments increase create/update request size, so those routes share the existing bounded attachment schema and whole-request body limit with direct sends. Attachment bytes live in the provider draft MIME, not the mirror database.

## Addendum (2026-08-27): saved drafts carry attachments

The earlier rejection was removed after the hosted direct-upload workflow made
agent-authored draft attachments necessary. No new compose path was added:
`DraftInput` now carries the existing `SendAttachment[]`, and `buildRawMime`
places those parts in the bytes APPENDed to Drafts. The CLI and HTTP draft
create/update surfaces accept the same bounded attachment representation. Because
`sendDraft` already resends the saved raw MIME, later delivery preserves the parts
without refetching or reconstructing them.
