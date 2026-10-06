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
  computes the cutoff once per pass and passes it to repository queries as a
  value, so the existing date indexes serve the predicate. The progress view,
  which cannot take a parameter, computes it per Mailbox Account inside a
  LATERAL join, which keeps it an index condition.
- The window limits only the expensive work: the initial-sync snapshot, the
  live body backlog and coverage, the non-CONDSTORE flag scan, and
  missing-in-DB repair. Reconcile (ADR 0038), new mail, and the CONDSTORE flag
  delta do not use it.
- New mail is every UID above the live head, whatever its date. The first
  snapshot sets the live head to UIDNEXT in the same write, so the archive below
  it stays the history lane's job and is never imported as new mail. One pass
  takes at most 20 incremental batches, saves its progress, and stores only the
  UIDNEXT it reached, so a large move of old mail arrives over several passes
  and the unchanged-folder proof cannot skip the rest.
- History is backfilled once. The periodic archive refresh,
  `archive_refresh_interval`, `archive_flag_sync`, and the preserve-flags write
  option are removed.
- The expiry job and the `EXPIRED` lane are removed.
- The search `window`/`lane` filter and the `window_status` field in search and
  read results are removed. Callers use the message date and `after:`/`before:`.
- Migration `0030` recomputes `imap_account_progress` by date. Every migrate
  re-applies every file, so each statement is idempotent. It repairs state the
  old code left:
  - completed folders whose live head sat below old UIDs start it at UIDNEXT, so
    that archive is not fetched again as new mail. Current code stores only the
    UIDNEXT a pass reached, so re-applying this changes nothing;
  - completed history snapshots are re-taken once where history is on,
    recovering old mail moved into a folder after its snapshot, which only the
    removed refresh found. The walk fetches only UIDs without a live row, and
    the folder keeps its history progress meanwhile. The obsolete refresh stamp
    marks the folders to re-run and is then cleared everywhere;
  - body-lane `MOVED_OUT` tombstones become the recoverable `RECONCILE_MISSING`.
- A history walk never re-fetches a UID that already has a live row.
- A folder gone past its grace period tombstones every row: `FOLDER_MISSING`
  inside the window, as before, and the recoverable `RECONCILE_MISSING` outside
  it, so the 30-day purge removes nothing it did not remove before.
- `WINDOW_DAYS` in the environment fails configuration with a typed error, and
  the REST search `window` parameter returns 400, so neither silently changes
  behaviour.
- The two lane-predicated indexes from `0001` and `0021` stay until the later
  migration that drops `window_status`: those files are re-applied on every
  migrate and would rebuild any index dropped here. (Done: once migrations ran
  once (ADR 0040), migration `0032` dropped the indexes and columns below and the
  `MOVED_OUT` reason, with a compatibility floor that keeps runtimes before 0030
  off that schema.)
- `window_status`, `last_archive_refresh_at`, `archive_refresh_interval`, and
  `archive_flag_sync` are no longer read or written; a later migration drops
  them once every host has stopped reading them, so a running old version never
  meets a missing column during a deploy.

## Consequences

- Nothing in the window can go stale, and no job maintains it.
- The monthly re-walk of every old message's metadata is gone.
- An old message moved into a folder appears on the next sync. A large move of
  old mail arrives over several bounded passes.
- The one-time history re-run lists every folder's old UIDs once and fetches
  only the missing ones.
- With history off, old mail moved into a folder before this change stays
  unmirrored, as the setting asks.
- On servers without CONDSTORE, flag changes to mail older than the window are
  no longer refreshed monthly; they were never refreshed unless
  `archive_flag_sync` was on.
- Breaking API changes: `archiveRefreshInterval` and `archiveFlagSync` are no
  longer accepted by `PATCH /accounts/:id/settings`; the search `window` filter,
  `windowStatus`, and the `window_status` result field are gone;
  `runRetentionJobs` no longer returns `expired`; `upsertMessages` and
  `applyFlagScan` no longer take a window cutoff.
