# ADR 0043: One IMAP login per action; a reused session selects again

Status: Accepted

## Problem

Each provider login costs time and counts against a provider's patience. Two
paths logged in more often than the work needed:

- A draft update opened one connection for the APPEND and a second for the old
  draft's delete. A draft send opened three: the raw fetch, the Sent APPEND and
  the draft delete.
- A host may keep one sync session open across passes (`client` with
  `keepClientOpen`). ImapFlow takes a mailbox lock without SELECT when that
  mailbox is already selected, and an untagged EXISTS updates only `exists`. A
  reused session therefore kept the last pass's UIDNEXT, and incremental sync,
  which reads up to UIDNEXT - 1, took one more pass for each new message.

Hosts also need to tell a rejected password from any other refused login, so a
connection limit is never treated as a wrong password.

## Decision

- `ActionConnection` is one direct action's IMAP connection. It opens on first
  use, gives every step the same socket, opens a new one only when the last one
  died (an SMTP submission can outlast an idle socket), and logs out once.
  Draft create, update and send use it; `SentFolderAppender`, `ContentImapClient`
  and `MailboxMutator` gain `over(socket)` for a socket the caller owns. A draft
  update logs in once, and a draft send once, plus one more only when the socket
  died during SMTP. After delivery, a teardown failure stays a warning.
- `MirrorImapClient.invalidateSelection()`: the sync engine calls it on a
  host-owned client at the start of every pass. The next lock on the mailbox that
  is still selected sends SELECT, which reads UIDNEXT again. A lock on another
  mailbox, or a QRESYNC lock, selects anyway and needs nothing extra. The engine
  never sends CLOSE, which would expunge `\Deleted` messages.
- `classifyLoginRefusal(error)` splits a refused LOGIN by RFC 5530:
  `credentials_rejected` for AUTHENTICATIONFAILED, AUTHORIZATIONFAILED or
  EXPIRED; `login_refused` for any other refusal, such as a bare NO, `[ALERT]` or
  a connection limit; `null` for transient codes, dead connections and other
  errors. `isAuthError` and the full pass's parking are unchanged.

## Consequences

- A draft update costs one login instead of two, and a draft send one instead of
  three.
- A host may reuse one sync session across passes without missing new mail.
- Hosts can park a mailbox only on a credential verdict and back off on any other
  refusal.
