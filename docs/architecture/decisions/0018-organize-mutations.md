# ADR 0018: Organize Mutations Are Write-Only Verbs Outside the Agent Surface

Status: Accepted

Date: 2026-06-21

## Context

email-001 (ADR 0017) added the first IMAP write capability — SMTP send + APPEND
to Sent — and established the pattern for doing so safely: write verbs live in a
new module outside `src/mcp/`, on a dedicated write-only client, never on the
read-only sync adapter (`MirrorImapClient`/`ThrottledImapClient`).

email-002 needs the rest of the mechanical "do anything with my mailbox" verbs:
mark read/unread, star/flag, move between folders, delete/trash (and hard
delete/expunge), the same applied across a whole thread, and folder CRUD
(create/rename/delete). These are all IMAP state mutations (`STORE`, `MOVE`/`COPY`,
`EXPUNGE`, mailbox `CREATE`/`RENAME`/`DELETE`). The tension is identical to ADR
0014/0016/0017: deliver mutation value without breaching the zero-send, read-only
agent surface, and without giving the sync adapter a write verb it could fire
mid-reconcile.

## Decision

Organize mutations are mechanical primitives authored **outside `src/mcp/`**, on a
new write-only `MailboxMutator` IMAP client (mirroring email-001's
`SentFolderAppender`):

- `MailboxMutator` reuses the exact connect + decrypt + `assertSafeImapTarget`
  (SSRF guard) pattern and exposes only the mutation verbs (`addFlags`/`removeFlags`,
  `move`, `expunge`, `createFolder`/`renameFolder`/`deleteFolder`, `list`). The sync
  read adapter gains no write verb (`sync-adapter-read-only.test.ts` enforces this).
- Every per-message verb is **UID-addressed under a UIDVALIDITY guard**: the
  message's mirror row supplies `folder + uidvalidity + uid`; if the server's
  UIDVALIDITY no longer matches, the verb aborts rather than touching the wrong
  message. Thread-level verbs resolve the live members from the mirror and apply
  the verb to each.
- **Flag mutations write through to the mirror immediately**; moves and deletes
  reconcile on the next sync pass. A flag change (mark read/unread, star/unstar)
  updates the KNOWN message row's `flags` to a KNOWN value right after a successful
  STORE — a deterministic write of existing identity, not fabricating identity, so
  it stays within the email-001 rule. This is required because the flag-scan sync
  only re-reads flags within `FLAG_DIFF_WINDOW_DAYS` (~7 days), so a flag change on
  older mail would otherwise never reconcile. Moves and deletes remain
  IMAP-authoritative and converge when the next UID reconcile runs.
- **Destructive verbs require server capabilities** so a fallback can never run a
  blanket EXPUNGE. Hard delete (EXPUNGE) requires `UIDPLUS` (UID-scoped EXPUNGE);
  move requires `MOVE` or `UIDPLUS` (native move, or COPY + UID-scoped EXPUNGE). If
  the server advertises neither, the verb refuses (`MailboxCapabilityError`) rather
  than risk imapflow's blanket-EXPUNGE fallback purging unrelated `\Deleted`
  messages. A UIDVALIDITY mismatch raises `MailboxConflictError`, surfaced as HTTP
  409.
- Surfaces follow "one core lib, four front doors": library functions exported
  from the barrel, `API_TOKEN`-gated HTTP routes, and CLI commands. Destructive
  verbs (delete / hard-delete / folder delete) require an explicit `--confirm` on
  the CLI; non-destructive verbs (mark/star/move) do not.
- The agent MCP surface stays the five read tools (ADR 0014 holds);
  `agent-surface-zero-send.test.ts` is unchanged and green. No mutation verb is
  reachable from `src/mcp/`.

## Consequences

- The agent read surface and the sync read path are provably unchanged; mutations
  are available to operators (CLI), the single-tenant HTTP door, and the cloud
  multi-tenant wrapper.
- Flag changes are visible in the mirror immediately (write-through). Move and
  delete changes are not reflected until the next UID reconcile, which can lag by
  more than the flag-scan window for older mail — callers should treat move/delete
  mirror convergence as eventual, while flag state is immediate.
- Hard delete (`EXPUNGE`) and folder delete are irreversible; the `--confirm` gate
  and the API_TOKEN boundary are the guards. This supersedes the *scope* (not the
  spirit) of ADR 0014/0016 for these new modules only, exactly as ADR 0017 did.
