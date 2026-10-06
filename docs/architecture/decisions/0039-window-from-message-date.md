# ADR 0039: The Live Window Is Computed From The Message Date

Status: Accepted

Date: 2026-10-06

## Context

The live window exists for one reason: to bound the expensive sync work, so a
new Mailbox Account has recent mail first and recurring scans stay small.
SupaMail also stored the window on every row as `window_status`
(`IN_WINDOW`, `EXPIRED`, `HISTORICAL`). The label described time, so it was
wrong as soon as time passed unless a job rewrote it. Every defect in this area
came from that copy:

- A host that never ran the expiry job kept aged rows `IN_WINDOW`, and the
  date-scoped reconcile tombstoned them while they were still in the folder
  (fixed by ADR 0038).
- New mail was fetched only when its date was inside the window. An old message
  moved into a folder gets a new UID, but it stayed invisible until the next
  archive refresh, or forever with history off.
- A monthly archive refresh re-fetched every old message's metadata to catch up
  on what the label and the date filter missed.
- The engine read a global `WINDOW_DAYS` while each Mailbox Account also stored
  `live_window_days`, which nothing read.

## Decision

**The window is computed from `internal_date` and the Mailbox Account's
`live_window_days` wherever it is needed. No row stores it.**

- `live_window_days` is the one source. `WINDOW_DAYS` is removed. The engine
  computes the cutoff once per pass; SQL computes it once per query
  (`now() - live_window_days * interval '1 day'`), so the existing date indexes
  serve the predicate.
- The window limits only the expensive work: the initial-sync snapshot, the
  live body backlog and coverage, the non-CONDSTORE flag scan, and
  missing-in-DB repair. Reconcile (ADR 0038), new mail, and the CONDSTORE flag
  delta do not use it.
- New mail is every UID above the live head, whatever its date. The first
  snapshot starts the live head at UIDNEXT, so the archive below it stays the
  history lane's job and is never imported as new mail.
- History is backfilled once. The periodic archive refresh,
  `archive_refresh_interval`, `archive_flag_sync`, and the preserve-flags write
  option are removed.
- The expiry job and the `EXPIRED` lane are removed.
- The search `window`/`lane` filter and the `window_status` field in search and
  read results are removed. Callers use the message date and `after:`/`before:`.
- Migration `0030` recomputes `imap_account_progress` by date and replaces the
  lane-predicated body indexes with one `imap_messages_unfetched_body_idx`.
  `window_status`, `last_archive_refresh_at`, `archive_refresh_interval`, and
  `archive_flag_sync` are no longer read or written; a later migration drops
  them once every host has stopped reading them, so a running old version never
  meets a missing column during a deploy.

## Consequences

- Nothing in the window can go stale, and no job maintains it.
- The monthly re-walk of every old message's metadata is gone.
- An old message moved into a folder appears on the next sync. A large move of
  old mail arrives through the existing bounded incremental batches.
- After this change, a folder whose live head sat below old UIDs fetches those
  UIDs once as new mail; the upsert is idempotent for rows the history lane
  already mirrored.
- On servers without CONDSTORE, flag changes to mail older than the window are
  no longer refreshed monthly; they were never refreshed unless
  `archive_flag_sync` was on.
- Breaking API changes: `archiveRefreshInterval` and `archiveFlagSync` are no
  longer accepted by `PATCH /accounts/:id/settings`; the search `window` filter,
  `windowStatus`, and the `window_status` result field are gone;
  `runRetentionJobs` no longer returns `expired`; `upsertMessages` and
  `applyFlagScan` no longer take a window cutoff.
