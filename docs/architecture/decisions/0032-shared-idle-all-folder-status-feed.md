# ADR 0032: Extend the Shared IDLE Session with an All-Folder STATUS Feed

Status: Accepted

Date: 2026-08-16

## Context

ADR 0031 made Inbox IDLE a low-latency hint while the periodic full sync stayed
authoritative. That leaves changes in Archive, Sent, custom folders, and other
tracked mailboxes waiting for the outer loop.

Current Gmail, Microsoft Graph, JMAP, and Thunderbird designs separate lossy
notification from durable replay. Current ImapFlow supports STATUS, CONDSTORE
`CHANGEDSINCE`, and QRESYNC, but not NOTIFY. QRESYNC couples SELECT state to
VANISHED and flag events, so SupaMail must capture that replay before treating
a persisted cursor as advanced.
GreenMail 2.1.8 also lacks CONDSTORE and QRESYNC, so a correct generic path must
retain plain UID reconciliation.

## Decision

Keep one read-only Inbox IDLE connection per Mailbox Account. Every 60 seconds,
use that connection to STATUS a bounded, rotating batch of tracked non-Inbox
folders. Inbox stays on IDLE so the same change is not queued twice.

An independently deployable `IMAP_LIST_STATUS_ENABLED` layer may replace that
batch with one LIST-STATUS command when the authenticated server advertises the
extension. It is off by default. The command contains only the current tracked
folder patterns. The response is filtered back to those exact paths, and every
tracked folder must have a complete snapshot. The pinned ImapFlow dependency is
patched to send this as one strict status-only command: no subscription lookup,
auxiliary metadata, retry ladder, folder-cache update, or implicit per-mailbox
STATUS fallback can bypass SupaMail's command throttle. A rejected, failed,
empty, malformed, or partial response disables LIST-STATUS for that session and
immediately returns to the bounded STATUS path. The dirty-signal and exact
reconciliation semantics below do not change.

Mailbox names containing LIST wildcards (`*` or `%`) cannot be represented as
exact LIST patterns. Such a session stays on bounded STATUS rather than issuing
a broader provider query.

The session snapshots `UIDVALIDITY`, `UIDNEXT`, `MESSAGES`, `UNSEEN`, and
`HIGHESTMODSEQ` when available. A changed fingerprint is only a dirty signal.
It carries the folder path and exact observed snapshot into the existing sync
engine, which bypasses normal due times for that folder. Structural changes
force streamed UID reconciliation; modseq or unseen changes force flag work.
Direct Inbox IDLE events enter the same feed so concurrent Inbox and non-Inbox
changes cannot shadow one another.

When CONDSTORE is available, flag work streams `CHANGEDSINCE` from the
persisted folder modseq in bounded write batches and advances the cursor only
after every batch succeeds. A folder snapshot is acknowledged individually
only after its required flag and reconcile work completes cleanly. Retained
snapshots are re-emitted while the rotation continues probing other folders.
The periodic full loop and its UID-set comparison remain the correctness
backstop.

An independently deployable `IMAP_QRESYNC_ENABLED` layer requests a real
QRESYNC re-selection when a completed folder has persisted UIDVALIDITY and a
deletion-complete QRESYNC mod-sequence cursor and the server advertises QRESYNC.
That cursor is separate from the flag-only CONDSTORE HIGHESTMODSEQ cursor, so a
flag scan cannot move replay past unseen VANISHED history. The pinned ImapFlow
dependency is patched so a replay cursor cannot take its same-mailbox lock fast
path and silently skip SELECT. SupaMail captures exact changed flags and
VANISHED UIDs during selection, applies them in bounded writes, and advances
the QRESYNC cursor only after the complete replay succeeds. Rejection, cursor
invalidity, sequence-only EXPUNGE, malformed events, or capture-budget overflow
returns immediately to CONDSTORE plus exact UID reconciliation. One rejection
disables QRESYNC for that connection. A successful QRESYNC replay may satisfy a
dirty structural wake, but it never stamps the periodic full-reconcile cursor;
the scheduled exact UID audit remains independent.

Each renewal probes at most
`MAX_PRIORITY_FOLDERS_PER_CYCLE + MAX_RR_FOLDERS_PER_CYCLE` folders. With the
defaults, 15 folders are checked per minute; larger tracked sets rotate, so the
worst-case detection bound is `ceil(non-Inbox tracked folders / 15)` minutes.
Each live pass consumes at most the same configured batch. Initial connection
setup records a baseline for every tracked folder, capped by the Mailbox
Account's effective folder limit.
Forced UID reconciles and flag scans still respect their existing per-cycle
caps; unfinished snapshots remain pending and wake later bounded passes.

## Consequences

- Adds, moves, and deletes in every tracked folder normally wake sync within
  one rotation instead of waiting for the outer loop.
- Dovecot-class servers also detect arbitrary flag changes through modseq.
- Servers without CONDSTORE detect read/unread changes through `UNSEEN`; other
  flag-only changes still rely on bounded flag scans and the periodic loop.
- STATUS is not deletion truth. Exact UID reconciliation remains mandatory.
- No persistent connection is added per folder. QRESYNC is independently
  flagged, and NOTIFY remains a separate future layer.
- LIST-STATUS reduces polling commands. It does not make its counts
  authoritative and does not replace the bounded STATUS fallback.
- The public session API remains compatible with hosts already passing its
  shared client to the live Inbox lane.

## Verification Plan

- Unit tests cover non-Inbox STATUS wake creation, pending snapshot retention,
  bounded change-feed behavior, LIST-STATUS command reduction and fallback,
  and CONDSTORE `CHANGEDSINCE` requests.
- Live-DB integration proves that an Archive replacement targets only Archive,
  inserts the new UID, tombstones the removed UID, and acknowledges afterward.
- Dovecot 2.4.1 smoke proves structural plus flag convergence through the
  QRESYNC path, confirms VANISHED replay, and records mutation-to-wake latency.
- GreenMail 2.1.8 smoke proves a non-Inbox addition through basic STATUS without
  CONDSTORE and records mutation-to-wake latency.
- The full typecheck, unit, build, live-DB, and both protocol smoke lanes remain
  required before merge.

## Current References

- Gmail push guide, updated 2026-07-22:
  <https://developers.google.com/workspace/gmail/api/guides/push>
- Microsoft Graph delta overview, updated 2025-04-30:
  <https://learn.microsoft.com/en-us/graph/delta-query-overview>
- JMAP Web Push, published March 2025: <https://www.rfc-editor.org/rfc/rfc9749.html>
- ImapFlow 1.6.1, released 2026-07-27:
  <https://github.com/postalsys/imapflow/releases/tag/v1.6.1>
- Dovecot 2.4.1, released 2025-03-28:
  <https://github.com/dovecot/core/releases/tag/2.4.1>
- GreenMail 2.1.8, released 2025-12-14:
  <https://github.com/greenmail-mail-test/greenmail/releases/tag/release-2.1.8>
- CONDSTORE and QRESYNC semantics: <https://www.rfc-editor.org/rfc/rfc7162.html>
