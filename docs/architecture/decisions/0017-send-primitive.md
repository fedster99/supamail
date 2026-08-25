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
  MCP tools, and none can send. Send is not a sixth local MCP tool; deployments
  can add their own explicitly authorized wrapper.
- **Compose with nodemailer's `MailComposer`, deliver the EXACT composed bytes.**
  MIME folding / quoted-printable / multipart / Message-ID generation is the
  long-tail correctness surface where hand-rolling bites, so we do not hand-roll.
  When a request supplies both plain and HTML bodies, both are passed to
  `MailComposer`, which emits `multipart/alternative` with the plain fallback
  before the richer HTML representation.
  A Message-ID is stamped at compose time (caller-supplied wins) so the mirrored
  Sent copy's `rfc_message_id` is known at send time and dedups against the later
  synced copy. The same `raw` bytes are BOTH submitted over SMTP (`raw:`) and
  APPENDed to Sent, so the delivered and filed bytes are byte-identical
  (threading/dedup coherence). This byte identity is load-bearing — recomposing
  separately for APPEND would break dedup.
- **Serialize the whole outbound provider operation with the account lock.**
  `sendMessage` acquires the same session advisory lock used by sync and draft
  APPENDs before SMTP submission, and keeps it through Sent APPEND and IMAP
  teardown. It fails closed if the initial heartbeat cannot persist and refreshes
  that heartbeat below the stale-reaper threshold for the full operation.
  Immediately before SMTP it re-proves heartbeat persistence and exact session
  ownership; immediately after SMTP acceptance it marks the operation confirmed.
  Known-lost liveness therefore cannot cross the irreversible boundary, while a
  later liveness/unlock failure is a warning on the delivered result. If the
  non-blocking lock is unavailable, it throws
  `AccountBusyError` before SMTP delivery; the HTTP surface maps that to
  `503 account_busy` plus `Retry-After`. This makes that specific failure
  proven-unsent and safe for a caller to retry, while preserving the existing
  rule that an ambiguous SMTP failure must not be retried blindly.
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

The single-account HTTP door (`POST /accounts/:id/send`, behind the existing
`API_TOKEN` bearer) and the CLI verbs (`send` / `reply`, both requiring an
explicit `--confirm`) are the built-in human-in-the-loop gates. Other deployments
provide their own send authorization and durable idempotency ledger. Those
concerns do not enter the core schema.

This supersedes the **scope** (not the spirit) of ADR 0014/0016 for the new
modules only: 0014's read-only agent surface and 0016's produce-only drafter
stand unchanged; send is a fresh, separately-accepted capability that lives off
that surface, exactly as 0014 required any write capability to be a new decision.

## Consequences

- An operator/agent can send a correctly-threaded reply or a new message end to
  end, while the agent MCP surface stays provably zero-send.
- A direct send may fail transiently with `AccountBusyError` when sync or another
  account-scoped provider operation owns the lock. No SMTP delivery has happened
  in that case; HTTP callers receive `503 account_busy` and may retry according
  to `Retry-After`.
- "Sent-but-not-appended" is the one genuinely lossy failure (SMTP delivers, then
  APPEND fails). v1 deliberately does not roll back a delivered email; it logs a
  warning and relies on the next sync to mirror the Sent copy if the provider
  auto-filed it. A retry queue is added only if it bites.
- Once SMTP delivery is confirmed, Sent-appender logout/fallback-close failures
  are warnings in the delivered result, never thrown failures that invite a
  duplicate re-send.
- Nodemailer transport close follows the same phase rule: `sendMail` failure
  throws a typed outcome, but `transporter.close()` failure after acceptance is
  reported through the delivered result's warnings and never overwrites
  confirmation.
- Core returns accepted recipients, rejected recipients, and the final SMTP
  response. Only a complete SMTP 4xx or 5xx reply is a provider rejection. A
  partial positive reply, a lost final reply, or an unqualified connection loss
  has outcome `unknown`. A proven failure before submission, such as DNS,
  authentication, TLS, connection setup, compose, or account lookup, has outcome
  `not_delivered`.
- SMTP connection and greeting setup keep the short `CONNECT_TIMEOUT_MS`.
  Waiting for the final DATA response uses `SMTP_COMMAND_TIMEOUT_MS`, which
  defaults to 10 minutes as required by RFC 5321. It does not reuse the
  one-minute IMAP command timeout. A shorter final-response timeout can create a
  false `unknown` result and invite a duplicate send.
- Core does not retry. Deployments that need retry orchestration own the durable
  operation ledger, permission checks, and Sent reconciliation around this
  primitive without editing the `imap_*` schema.

## Verification

- `agent-surface-zero-send.test.ts` stays green and unchanged: send modules are
  outside `src/mcp/`, no MCP tool exposes a send key, exactly 5 read tools.
- `sync-adapter-read-only.test.ts` asserts the sync adapter exposes no
  append/store/expunge/setFlags (APPEND lives only on `SentFolderAppender`).
- `send.test.ts` covers Message-ID stamping/honoring, In-Reply-To/References merge
  on the NULL `provider_thread_id` generic-IMAP path, CC/BCC/custom-header
  encoding, byte-identical deliver-vs-append, lock coverage across delivery,
  APPEND, graceful/fallback teardown, busy-before-delivery behavior,
  pre/post-confirmation liveness fault injection, deliver-before-append ordering,
  and post-delivery APPEND/close warning paths. `smtp-client.test.ts` separately
  proves transport-close failure cannot overwrite SMTP acceptance or the original
  SMTP error. `smtp-outcome.integration.test.ts` uses a local SMTP server to prove
  that loss of the final response after accepted DATA returns `unknown`.
- `send.live-db.test.ts` proves against real Postgres sessions that a competing
  advisory-lock owner prevents delivery, direct and draft sends contend on the
  same lock, the lock remains held through graceful/fallback teardown, and a
  heartbeat keeps a long send safe from stale-lock recovery before final release.
  It also proves a fault-injected false unlock evicts the client and releases the
  lock for another real session.
- `smtp-outcome.integration.test.ts` delays a valid final `250` beyond the IMAP
  command timeout and proves the independent SMTP timeout waits for it.
- `host-validation.test.ts` covers `assertSafeSmtpTarget` SSRF rejection.
- The GreenMail smoke (`scripts/greenmail-smoke.ts`) submits → APPENDs to Sent →
  syncs → asserts the mirrored Sent row is FETCHable (requires Docker).

## Review follow-up (idempotency, STARTTLS, SSRF, header trust)

A whole-stack review hardened four send-path edges:

- **SMTP outcome contract.** `POST /send` is not retry-safe on its own. A stable
  Message-ID is only a reconciliation key; it does not stop SMTP from accepting
  the same message twice. `deliverSmtp` returns the accepted/rejected recipient
  receipt. It wraps failures in `SmtpDeliveryError`: proven non-delivery is
  `not_delivered`; an ambiguous final result is `unknown`. The HTTP API and CLI
  expose this outcome without provider details. Callers may retry only
  `not_delivered`. Any remote wrapper must keep a durable idempotency ledger and
  never resubmit `unknown`.
- **STARTTLS decoupled from the private-hosts opt-in.** `deliverSmtp`'s
  `requireTLS` no longer keys off `IMAP_ALLOW_PRIVATE_HOSTS`. A non-implicit-TLS host
  that resolved PUBLIC keeps `requireTLS=true` even when the opt-in is set (so a
  self-hoster who enables the flag AND sends through a real public :587 provider can
  never silently fall back to cleartext / MITM-strip). STARTTLS relaxes only when the
  target actually resolved private/loopback — `assertSafeSmtpTarget` now returns an
  `isPrivateHost` signal that `send.ts` plumbs into `deliverSmtp`.
- **SSRF is check-time, not connect-time (DNS-rebinding TOCTOU).** `host-validation.ts`
  resolves and rejects private IPs but does NOT pin the resolved IP; `deliverSmtp`
  re-resolves at socket time, so a low-TTL record can be public-at-check and
  private-at-connect. Acceptable for an operator-controlled single-account host;
  a deployment accepting untrusted user-supplied hosts must pin the resolved IP and
  connect to the literal address with `tls.servername` for SNI. A prominent comment
  in `host-validation.ts` records this. See ADR 0022.
- **Header trust boundary.** `buildRawMime` now denylists structural/identity headers
  (Bcc/From/To/Cc/Sender/Reply-To/Return-Path/Received/Content-Type/MIME-Version) in
  `req.headers` and restricts customs to `X-*` (plus the threading headers), so a
  caller can no longer forge a From / smuggle a raw Bcc into the bytes that are BOTH
  delivered and filed to Sent. Drafts reuse `buildRawMime`, so this protects
  `createDraft`/`updateDraft` too. The send/draft Zod schemas additionally reject CR/LF
  in `headers` values / `inReplyTo` / `references` / `messageId` (header-injection
  defense in depth).

## References

- ADR 0002: Node-side credential encryption (the frozen AES-256-GCM envelope the
  SMTP secret reuses).
- ADR 0007: Stable core distribution contracts.
- ADR 0014: Agent email access is a read-only core surface (the boundary this
  preserves).
- ADR 0016: The reply drafter produces, never sends (this is the send path it
  defers to).
- ADR 0003: Session-affine Postgres advisory locks serialize account operations.
- `apps/api/src/send.ts`, `apps/api/src/smtp-client.ts`,
  `apps/api/supabase/migrations/public/0009_smtp_send.sql`.
- RFC 5322 §3.6.4 (message threading: In-Reply-To / References).
- RFC 5321 §4.5.3.2.6 (10-minute timeout for the final DATA response).
- RFC 1047 (the final-response synchronization gap and duplicate mail).
