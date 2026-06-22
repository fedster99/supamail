# ADR 0020: Attachment Bytes + Raw MIME Are On-Demand Reads; Metadata + Clean Bodies Come From the Mirror; All Off the Agent Surface

Status: Accepted

Date: 2026-06-22

## Context

email-004 adds the Nylas content-parity surface: attachments on send/draft, attachment download + metadata, inline images (Content-ID), raw MIME, full/basic headers, payload field-selection, and deterministic clean bodies. Two pressures shape it:

1. **Storage reality.** The mirror stores attachment *metadata* (`imap_attachments`) and parsed bodies/headers, but under the production default `BODY_STORAGE_MODE=parsed_only` it stores **no** attachment bytes and **no** `raw_mime` (see the parsed-only body-storage decision). So byte-level reads cannot always come from the mirror.
2. **The sacred boundaries.** The agent MCP surface is the five read tools (ADR 0014) and stays zero-send/read-only (ADR 0017); the sync adapter (`ThrottledImapClient`) must never gain a write verb (ADR 0018). The server instructions also say the *agent* surface exposes attachment metadata only — never bytes.

## Decision

- **Compose half** rides email-001: `SendRequest.attachments` (filename/contentType/base64 content, optional `cid` + `inline`) flow through the existing `buildRawMime` (nodemailer MailComposer handles MIME + inline `cid`), reused by both send and draft create — no new compose path.
- **Read half lives in a new `content.ts`, OUTSIDE `src/mcp/`**, reachable via the lib barrel + `API_TOKEN` HTTP routes + the CLI — **never as a sixth MCP tool** (so `agent-surface-zero-send.test.ts` stays unchanged and still asserts exactly five tools).
- **Storage-aware read strategy:**
  - Attachment **metadata** → mirror (`imap_attachments`), cheap SELECT.
  - Attachment **bytes** → ALWAYS an on-demand IMAP part FETCH (never mirrored).
  - **Raw MIME** → mirror `raw_mime` when present (`raw_mime` mode), else on-demand whole-message FETCH (`parsed_only`).
  - **Headers** → mirror `headers_json` (+ body headers), with an on-demand FETCH+parse fallback only when nothing is stored.
  - **Clean body** → STORED body text only (no IMAP), reusing the existing deterministic `cleanBody` heuristic (strip the `On … wrote:` quoted tail + the `-- ` signature unless `includeQuoted`). No LLM, no new dependency.
- On-demand fetches use a narrow read-only `ContentImapClient` exposing only `downloadPart()` / `fetchOneSource()` — UIDVALIDITY-guarded so a server reset can never make us fetch a different message. It is **not** the sync adapter (`sync-adapter-read-only.test.ts` holds) and never writes; it reuses the frozen connect + `decryptPassword` + `assertSafeImapTarget` pattern.
- **Field selection** (`selectFields` / `?fields=` / `--fields`) is a pure top-level projection to shrink read payloads.

## Consequences

- Attachment download and (under `parsed_only`) raw MIME / header-fallback each cost one live IMAP round-trip — acceptable; they are explicit, on-demand reads, not hot-path sync.
- The agent MCP surface is unchanged: bytes/raw/headers/clean-body are operator/automation reads behind `API_TOKEN`, not agent tools. A future agent must NOT add a sixth MCP tool for these (it would break the five-tool assertion).
- `cleanBody` is deterministic text parsing reused from the shared read layer — it must stay model-free (the "no LLM inside the product" rule).
- Byte reads inherit the UIDVALIDITY guard, so a mailbox reset fails closed rather than returning the wrong part.
