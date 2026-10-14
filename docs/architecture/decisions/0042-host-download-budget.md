# ADR 0042: Core meters downloads; the host owns the download budget

Status: Accepted

## Problem

Some providers cap how much one mailbox may download. Gmail allows 2,500 MB a
day, shared with the User's own apps, and suspends IMAP in every client for
1–24 hours when an account goes over. Zoho caps IMAP fetch at 250 MB
(personal) or 1 GB (organization) per 15 minutes. A first sync of a large
mailbox downloads several GB, so an unmetered mirror can lock the User out of
their own mail. The limits, their windows, and the share left for the User are
provider policy, and the usage must survive restarts and span passes.

## Decision

Core counts every IMAP byte a pass receives (`SyncResult.downloadedBytes`, also
stored in `imap_sync_runs.metadata`). A host may pass
`syncAccount(..., { downloadBudgetBytes })`: the bytes this pass may download
before older mail's bodies pause. The host computes it from its own durable
counter and adds `downloadedBytes` back after the pass.

- The budget gates only older mail's bodies: bodies dated before the newest 7
  days, in the body backlog and in the history lane.
- New mail, metadata, and bodies from the newest 7 days never wait. Their bytes
  still count, because the provider counts them.
- Before an older body would take the pass past the budget, older bodies stop
  for the rest of the pass, so they still arrive newest first. A body is
  charged its RFC822.SIZE, capped at `BODY_RAW_MAX_BYTES`.
- Once they stop, the body backlog reads only recent bodies, and history takes
  metadata work only (walks and snapshots, no body batches). Older mail stays
  findable by sender, subject, and date; its bodies wait for the next budget.
- `SyncResult.downloadBudgetReached` reports that the budget paused older
  bodies in this pass.
- A session that cannot count its bytes gets no older bodies under a budget.

Without `downloadBudgetBytes`, sync behaves as before.

RFC 5530 `OVERQUOTA` at LOGIN, on a command, or in a BYE is the provider's
command or bandwidth limit on a read-only sync session, never a rejected
credential. The pass records `RATE_LIMITED` and waits at least an hour
(`PROVIDER_OVER_QUOTA_RETRY_MS`), from any pass type. The imapflow patch keeps
a BYE's response code on the connection errors that follow it, so the
classification reads the code, not the server's text.

## Consequences

- Core holds no window state and no provider table; one pass is the unit it
  meters. The host must serialize a mailbox's passes, or the remaining budget it
  reads can be stale by one pass.
- On-demand body reads (`fetchBody`) are not metered by the sync pass.
