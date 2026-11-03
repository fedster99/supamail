# ADR 0051: A direct action can reuse a parked session

Status: Accepted

## Problem

Every direct action logs in and out (ADR 0043 made that once per action, not
once per step). A login costs about nine round trips plus the server's password
check, and it is the largest IMAP step of a draft save: in one hosted
deployment, 660 ms at the median over 589 saves, and 2.4 s for a mailbox whose
server is far from the host and slow to check passwords. Agents act in bursts:
about three quarters of a Tenant's actions start within 45 s of its previous
action ending, and each of them pays the login again.

## Decision

- A host may pass `MailboxActionOptions.sessions`, an `ActionSessionStore` with
  `take(key)` and `park(key, client)`. Core computes the key from the account id,
  host, port, TLS mode, username and encrypted password, so a session is never
  reused after the server or credentials change.
- `connectAbortableImap` takes the parked session for the key, sends NOOP, and
  uses it when it answers within `SESSION_REUSE_CHECK_MS` (5 s). A session that
  fails, stalls or closes, or whose action aborts during the check, is closed, and
  the action logs in as before (or fails as aborted). A reused session gets a new
  abort binding for the new action.
- `ImapAbortBinding.logout` parks the session instead of sending LOGOUT when the
  host gave a store, the client is still usable and the action was not aborted.
  Callers await every command before logout, so a parked session has none in
  flight. An aborted action, or a dead socket, never parks.
- `ActionConnection` reports a reused session as the IMAP step `reuse` instead
  of `connect`, so a host sees how often it saves the login.
- Draft create, update and send, send, flags, moves and message deletes pass the
  store through; a draft send's raw fetch runs on its reused connection and is
  awaited before logout. Two paths never take the store:
  - Attachment and header downloads (`ContentImapClient.connect`): a cancelled
    stream can leave a FETCH running on the connection.
  - Folder create, rename and delete: ImapFlow sends CLOSE before renaming or
    deleting the selected folder, and CLOSE expunges `\Deleted` messages (ADR
    0043 forbids it). A fresh session has no folder selected.

## Why a reused session needs no new SELECT

A reused sync session must select again because sync reads UIDNEXT (ADR 0043).
Actions never read UIDNEXT. They read UIDVALIDITY, which a server cannot change
for a mailbox during a session (RFC 3501 2.3.1.1), and the message count, which
the NOOP refreshes from the server's untagged EXISTS and EXPUNGE responses.
`findByMessageId` therefore reads the same newest messages it would after a new
SELECT.

## Host responsibilities

The host owns lifetime: how long a session stays parked, at most one per key,
and closing parked sessions on shutdown. A session must leave the store before
ImapFlow's command-socket timeout (`IMAP_COMMAND_TIMEOUT_MS`) closes it, or
reuse finds it dead and logs in. Without a store, behavior is unchanged.

## Verification

`imap-connect.test.ts` covers reuse, the key, a session that no longer answers,
a stalled NOOP, an abort during the check, and that an aborted action or a dead
socket never parks. `mailbox-mutations.test.ts` checks that folder changes never
receive the store.
`pnpm smoke:dovecot` saves three drafts and changes a flag through one store
against Dovecot, the last save after the session idled past ImapFlow's 15 s
auto-IDLE, and checks that every save reused the first login and was mirrored
at once.
