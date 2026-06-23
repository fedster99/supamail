# ADR 0017: SMTP Send/Reply Is a Separately-Gated Primitive Outside the Agent Surface

Status: Accepted

Date: 2026-06-21

## Context

The agent email surface is read-only and zero-send by construction: ADR 0014
made the MCP server + CLI a read-only window onto the Postgres mirror, and ADR
0016 made `draft_reply` produce-only (it composes a correctly-threaded reply and
stops — there is no send flag). The highest-value next capability is actually
*sending* that reply, plus composing brand-new mail. email-001 introduces that
send path.

The tension is the same one ADR 0016 named: offer the value of sending without
breaching the zero-send boundary that makes the agent surface safe to hand an
autonomous agent. A send capability touches three irreversible/security-sensitive
things — SMTP submission, IMAP APPEND to Sent, and decrypted credentials — none
of which may leak into the agent read surface or the sync read adapter.

## Decision

Send is a **single reusable primitive, authored outside `src/mcp/`**, shaped as a
superset so reply, new-compose, CC/BCC, and (later) idempotency are all the same
call:

```
sendMessage(pool, config, req: SendRequest): Promise<SendResult>
```

- **New modules, not the agent surface.** `send.ts` (orchestration) and
  `smtp-client.ts` (compose + SMTP transport + a write-only Sent appender) live in
  `apps/api/src/`, never under `src/mcp/`. The zero-send safety test
  (`agent-surface-zero-send.test.ts`) scans only `src/mcp/**` + the `TOOLS`
  registry, so it stays green and unchanged: the 5 read tools remain the only OSS
  MCP tools, and none can send. Send is NOT a 6th MCP tool here — human-confirm
  send is a cloud concern.
- **Compose with nodemailer's `MailComposer`, deliver the EXACT composed bytes.**
  MIME folding / quoted-printable / multipart / Message-ID generation is the
  long-tail correctness surface where hand-rolling bites, so we do not hand-roll.
  A Message-ID is stamped at compose time (caller-supplied wins) so the mirrored
  Sent copy's `rfc_message_id` is known at send time and dedups against the later
  synced copy. The same `raw` bytes are BOTH submitted over SMTP (`raw:`) and
  APPENDed to Sent, so the delivered and filed bytes are byte-identical
  (threading/dedup coherence). This byte identity is load-bearing — recomposing
  separately for APPEND would break dedup.
- **APPEND lives on a separate write-only client, not a widened read adapter.**
  `SentFolderAppender` reuses the connect + decrypt + `assertSafeImapTarget`
  pattern from `imap-client.ts` but exposes only `append()` (+ `list()` to resolve
  the Sent folder). `MirrorImapClient`/`ThrottledImapClient` (the sync read
  adapter) gain no write verb — pinned by `sync-adapter-read-only.test.ts`. The
  sync path can never write; the send path can never read-sync. Update (ADR 0022):
  that "reused pattern" is now an actual shared function, `connectImap`
  (`imap-connect.ts`) — `SentFolderAppender` obtains its socket there (and so
  inherits the close-on-connect-error guard it previously lacked); the append-only
  verb surface is unchanged.
- **Reuse the frozen AES-256-GCM envelope for the SMTP secret.** SMTP credentials
  are stored in nullable `smtp_*` columns on `imap_accounts` (migration 0009),
  with `encrypted_smtp_password` using the same envelope as `encrypted_password`
  (ADR 0002). A NULL SMTP username/secret reuses the IMAP creds — the common
  "same creds, SMTP on 465/587" case needs zero extra onboarding input.
- **SSRF guard on the SMTP target.** `assertSafeSmtpTarget` mirrors
  `assertSafeImapTarget` (private/reserved-range rejection, DNS resolution check),
  differing only in the allowed submission/relay ports (25/465/587) and in that
  `secure=false` means STARTTLS (a TLS upgrade), not plaintext.
- **No immediate mirror insert.** The APPEND files a real message in Sent; the
  existing sync pass FETCHes and mirrors it with a server-assigned UID on the next
  tick. Identity (`folder + UIDVALIDITY + UID`) is never guessed. APPENDUID is
  captured into `SendResult` for observability, not used to fabricate a row.
- **Provider SMTP defaults are explicit-only.** `ProviderProfile` gains an optional
  `smtpDefaults` hook, set ONLY for the real `rackspace` mapping
  (`secure.emailsrvr.com:465`). Generic IMAP requires explicit columns — ship the
  resolution-order hook, not speculative heuristics.

The single-tenant HTTP door (`POST /accounts/:id/send`, behind the existing
`API_TOKEN` bearer) and the CLI verbs (`send` / `reply`, both requiring an
explicit `--confirm`) are the OSS human-in-the-loop gates. Idempotency and the
two-phase human-confirm token are cloud responsibilities (a fast-follow), not in
this PR.

This supersedes the **scope** (not the spirit) of ADR 0014/0016 for the new
modules only: 0014's read-only agent surface and 0016's produce-only drafter
stand unchanged; send is a fresh, separately-accepted capability that lives off
that surface, exactly as 0014 required any write capability to be a new decision.

## Consequences

- An operator/agent can send a correctly-threaded reply or a new message end to
  end, while the agent MCP surface stays provably zero-send.
- "Sent-but-not-appended" is the one genuinely lossy failure (SMTP delivers, then
  APPEND fails). v1 deliberately does not roll back a delivered email; it logs a
  warning and relies on the next sync to mirror the Sent copy if the provider
  auto-filed it. A retry queue is added only if it bites.
- Double-send protection in v1 is the explicit `--confirm` (CLI) / single call
  (HTTP); the `imap_send_attempts` idempotency ledger is a fast-follow.
- The cloud re-pin inherits the primitive via `@supamail/api`; the cloud adds
  tenant scoping (RLS over the `app.tenant_id` DSN) and the human-confirm MCP
  tools — it never edits `imap_*` schema or the engine.

## Verification

- `agent-surface-zero-send.test.ts` stays green and unchanged: send modules are
  outside `src/mcp/`, no MCP tool exposes a send key, exactly 5 read tools.
- `sync-adapter-read-only.test.ts` asserts the sync adapter exposes no
  append/store/expunge/setFlags (APPEND lives only on `SentFolderAppender`).
- `send.test.ts` covers Message-ID stamping/honoring, In-Reply-To/References merge
  on the NULL `provider_thread_id` generic-IMAP path, CC/BCC/custom-header
  encoding, byte-identical deliver-vs-append, deliver-before-append ordering, and
  the APPEND-failure warning path.
- `host-validation.test.ts` covers `assertSafeSmtpTarget` SSRF rejection.
- The GreenMail smoke (`scripts/greenmail-smoke.ts`) submits → APPENDs to Sent →
  syncs → asserts the mirrored Sent row is FETCHable (requires Docker).

## References

- ADR 0002: Node-side credential encryption (the frozen AES-256-GCM envelope the
  SMTP secret reuses).
- ADR 0007: Public-core / hosted-cloud contract (cloud consumes this via re-pin).
- ADR 0014: Agent email access is a read-only core surface (the boundary this
  preserves).
- ADR 0016: The reply drafter produces, never sends (this is the send path it
  defers to).
- `apps/api/src/send.ts`, `apps/api/src/smtp-client.ts`,
  `apps/api/supabase/migrations/public/0009_smtp_send.sql`.
- RFC 5322 §3.6.4 (message threading: In-Reply-To / References).
