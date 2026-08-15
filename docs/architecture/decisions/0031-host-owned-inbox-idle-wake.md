# ADR 0031: Hosts May Use Inbox IDLE as a Wake Hint

Status: Accepted

Date: 2026-08-14

## Context

Periodic polling is reliable but adds avoidable delay for new Inbox mail and
Inbox deletions. Making every poll more frequent would multiply IMAP login,
folder, and database work. A persistent IMAP connection scales more directly,
but it can disconnect and provider event details are not durable truth.

## Decision

Public core exports one small session primitive that opens Inbox read-only and
returns normalized `exists`, `expunge`, or `flags` hints. It does not reconnect,
own workers, or write mirror rows.

The host owns listener placement, reconnect backoff, shutdown, and operational
controls. After a wake, the host calls the existing authoritative sync engine.
That live lane processes Inbox only. `EXPUNGE` forces an Inbox UID reconcile,
and `FLAGS` forces an Inbox flag scan. The normal account advisory lock still
serializes every mirror-changing IMAP operation. Host telemetry stays outside
the public mirror schema.

The host passes the same session into the authoritative sync engine and may keep
it open afterward. The periodic full-sync timer uses this session too. This
preserves the one-session-per-Mailbox-Account provider limit without removing
the polling/reconciliation recovery path.

## Consequences

- New Inbox mail and Inbox delete/flag changes can converge without waiting for
  their normal polling intervals.
- Provider events remain untrusted hints; existing sync and reconcile code owns
  every database mutation.
- A disconnect can delay a wake but cannot create a permanent missed message
  while periodic polling remains active.
- Moves and deletions outside Inbox still depend on periodic folder work.
- A host that wants persistent listeners must budget one quiet IMAP connection
  per active Mailbox Account and must respect provider connection limits.
- The primitive stays useful to OSS and hosted runtimes without putting hosted
  ownership or orchestration into public core.

## Verification

- Unit tests cover `exists`, `expunge`, `flags`, unsupported IDLE, disconnect,
  renewal, abort, listener cleanup, one-shot closure, and session reuse.
- A live-DB integration test proves that an IDLE-woken Inbox pass can mirror new mail
  and tombstone a provider-missing message without consuming Sent work.
- The Dovecot protocol smoke opens a real IDLE socket, receives an `EXISTS`
  wake, runs the Inbox sync through that same socket, then re-enters IDLE and
  receives a second wake.
- The normal polling worker and its reconciliation schedule remain unchanged.

## References

- GitHub issue #103: optional Inbox IDLE wake-up.
- `apps/api/src/inbox-idle.ts`
- `apps/api/src/sync-engine.ts`
- `apps/api/src/__tests__/inbox-idle.test.ts`
- `apps/api/src/__tests__/sync-engine.integration.test.ts`
