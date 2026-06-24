# ADR 0022: One Shared IMAP Connect Prelude (`connectImap`) Below the Verb Line

Status: Accepted

Date: 2026-06-23

## Context

By the end of the email-surface stack (ADR 0017/0018/0019/0020/0021) the codebase
had four narrow IMAP clients with deliberately distinct verb surfaces — the
read-sync `ThrottledImapClient` (`imap-client.ts`), the append-only
`SentFolderAppender` (`smtp-client.ts`), the mutation `MailboxMutator`
(`mailbox-mutations.ts`), and the download/fetch `ContentImapClient`
(`content.ts`). Each had hand-copied the SAME ~18-line connect prelude:
`assertSafeImapTarget` (SSRF/port/TLS guard) → `decryptPassword` (the frozen
AES-256-GCM envelope, ADR 0002) → `new ImapFlow({…timeouts})` → `connect()`.

Those four copies had **drifted on a security property**: the
close-the-socket-on-connect-failure guard (`try { connect() } catch { client.close(); throw }`)
was present in `MailboxMutator` and `ContentImapClient` but **missing** from
`createImapClient` and `SentFolderAppender` — so an auth/TLS failure during connect
leaked the socket on two of the four paths. A fix had landed in two copies and not
the other two. That drift is the proof the duplication was actively harmful.

The narrow verb surfaces themselves are NOT the problem — they are exactly what the
zero-send (ADR 0017) and read-only-sync (ADR 0014/0018) guards rely on, and must
stay separate. What was begging to be extracted is everything *below* the verb line.

## Decision

Extract one shared `connectImap(pool, config, account): Promise<ImapFlow>` in a new
module `apps/api/src/imap-connect.ts` (deliberately OUTSIDE `src/mcp/`, since it
constructs a write-capable `ImapFlow`). It owns the four load-bearing steps once —
the SSRF guard, the credential decrypt, ImapFlow construction with the exact timeout
wiring, and **the close-on-connect-error guard, now baked in** so all four clients
fail closed uniformly. The fix to the drift IS the extraction.

All four clients are re-pointed to obtain their socket from `connectImap` and keep
their own verb surface verbatim on top — `ThrottledImapClient` stays read-only,
`SentFolderAppender` append-only, `MailboxMutator` its mutation verbs,
`ContentImapClient` download/fetch. The verb surfaces are NOT merged; only the
plumbing moved below the verb line.

Co-located in the same module (CC-4): the shared UIDVALIDITY fail-closed comparison
(`uidValidityMatches`) and its message builder (`uidValidityMismatchMessage`). The
mutate path (`MailboxMutator.withUidScope`) and the on-demand fetch path
(`ContentImapClient.assertUidValidity`) implement the same property — "a UIDVALIDITY
reset must never act on / fetch the wrong message" — so the comparison + message live
once. Each call site **keeps its own thrown error type** (mutations throw
`MailboxConflictError` → HTTP 409; content throws a plain `Error`): only the
comparison + message string are shared, so no existing error contract changes.

This is a behavior-preserving refactor. It does not reopen ADR 0017/0018/0020 — those
already *described* this prelude as a "reused pattern"; this is the faithful
implementation of that claim (one-line notes added to each).

## Consequences

- SSRF/TLS/timeout policy, credential decryption, and the socket-leak guard live in
  exactly one place and can no longer drift between the sync, send, mutate, and fetch
  clients. The existing drift (the missing close-on-error guard on two clients) is
  fixed for all four at once.
- A fifth IMAP client (e.g. a future flag-resync reader) gets the hardened connect —
  SSRF guard, decrypt, and close-on-error — for free.
- The connect prelude is now testable through ONE Seam (`imap-connect.test.ts`)
  instead of indirectly per client.
- The verb-surface separation that the zero-send and read-only-sync guards rely on is
  untouched: `connectImap` only returns a socket; it exposes no verb. The two guard
  tests (`agent-surface-zero-send.test.ts`, `sync-adapter-read-only.test.ts`) stay
  green and unchanged.

## Verification

- `imap-connect.test.ts` (new) proves the shared connector closes the socket when
  `connect()` throws (the drift fix, now protecting all four clients), runs the SSRF
  guard + decrypt before construction, wires the exact timeout options, and covers the
  shared UIDVALIDITY comparison + message builder.
- The full existing suite (`pnpm test`) stays green and **unchanged** — that is the
  proof of no behavior change. `mailbox-mutator-capabilities.test.ts`'s m4
  "connect closes the socket on failure" test still passes (now exercising the shared
  path). `agent-surface-zero-send.test.ts` and `sync-adapter-read-only.test.ts` are
  unchanged and green.
- `pnpm typecheck` and `pnpm build` pass.

## Review follow-up (SSRF guard is check-time, not connect-time)

The shared SSRF guard (`assertSafeImapTarget` / `assertSafeSmtpTarget` in
`host-validation.ts`, run inside this prelude) resolves the host and rejects
private/reserved IPs, but it does NOT pin the resolved IP. The clients
(`connectImap` / `deliverSmtp`) re-resolve at socket time, so a low-TTL DNS record
can return public-at-check and private-at-connect (DNS-rebinding TOCTOU, e.g. a
metadata endpoint at `169.254.169.254`). In the single-tenant OSS host the target is
operator-controlled, so this is acceptable and the connect path is deliberately NOT
rewritten. The CLOUD MULTI-TENANT layer, where a tenant supplies the host, MUST close
this window: resolve once in the prelude, then connect to the LITERAL resolved IP with
`tls.servername = host` for SNI/cert validation so check and connect observe the same
address. A prominent comment in `host-validation.ts` records this for the cloud
implementer; the OSS guard is intentionally check-time only.

## References

- ADR 0002: Node-side credential encryption (the frozen AES-256-GCM envelope reused).
- ADR 0017: Send primitive (the `SentFolderAppender` connect copy, now shared; the
  drift fix gives it the close-on-error guard it lacked).
- ADR 0018: Organize mutations (`MailboxMutator` connect + the `withUidScope`
  UIDVALIDITY guard, now sharing the comparison).
- ADR 0020: Attachments/content (`ContentImapClient` connect + the `assertUidValidity`
  guard, now sharing the comparison).
- `apps/api/src/imap-connect.ts`, `apps/api/src/imap-client.ts`,
  `apps/api/src/smtp-client.ts`, `apps/api/src/mailbox-mutations.ts`,
  `apps/api/src/content.ts`, `apps/api/src/__tests__/imap-connect.test.ts`.
