# ADR 0038: Reconcile Compares The Whole Folder, In Every Window Lane

Status: Accepted

Date: 2026-10-05

## Context

Exact reconcile listed the provider's UIDs with a date search (`SINCE` the live
window cutoff) and tombstoned `IN_WINDOW` rows absent from that list. The date
search and the stored lane drift apart:

- A row stays `IN_WINDOW` after its date passes the cutoff until the host runs
  the expiry job. A host that never runs it keeps such rows `IN_WINDOW`
  indefinitely. The date search no longer returns them, so reconcile tombstones
  mail that is still in the folder. The monthly history walk revives the row,
  and the next reconcile tombstones it again. Production evidence showed such
  rows marked only after they crossed the cutoff, never before.
- `HISTORICAL` and `EXPIRED` rows were never reconciled. A deleted or moved
  archive message stayed live in reads and search. supamail#194 added a check at
  each archive refresh, which bounds detection by the refresh interval (30 days
  by default) and never runs with history off.
- IMAP `SINCE`/`BEFORE` compare dates only, in the server's time zone, so a row
  near the cutoff can fall on either side.

A folder's membership has no window. The provider lists it exactly with
`UID SEARCH ALL`, one compact response at about 7 bytes per UID.

## Decision

**Each exact reconcile compares the folder's complete UID list with every live
row of that UIDVALIDITY, whatever its lane.**

- One `UID SEARCH ALL` lists the folder. A second `UID SEARCH SINCE <cutoff>`
  selects the UIDs the live window may fetch.
- Rows below the UIDNEXT seen at SELECT whose UID is not listed are tombstoned
  `RECONCILE_MISSING`. A higher UID may have arrived after the list, for example
  through a confirmed move on another connection, so the list cannot prove it
  gone.
- `RECONCILE_MISSING` rows outside the window whose UID is listed again are
  revived in place. UIDs are never reused within one UIDVALIDITY, so a listed
  UID proves the message is still there. Inside the window, missing-in-DB repair
  re-fetches them instead, so their flags are current. Other tombstone reasons
  are never revived by SQL.
- Missing-in-DB repair stays inside the window, so reconcile never turns into
  archive backfill.
- Tombstones and revivals commit in batches of 5,000 rows, each under its own
  check of the folder generation. Every batch is proven by the same list, so a
  partial run is safe and the next reconcile completes it.
- The list is proof only when its distinct size equals SELECT's message count,
  read after both searches. Otherwise, or when a search fails, reconcile raises
  `IncompleteUidListError`, changes nothing, records a `RECONCILE_INCOMPLETE`
  event and an unclean reconcile, and the folder retries on the next sync
  cadence. The rest of the folder's sync still commits.
- Two client gaps would break that count, and both are fixed in the pinned
  ImapFlow patch. A QRESYNC `VANISHED` response now lowers EXISTS the way
  `EXPUNGE` does. An ESEARCH `ALL` set that cannot be expanded exactly (more
  UIDs than EXISTS, or invalid entries) now fails the search instead of
  returning a truncated list.
- A body fetch that finds its UID gone tombstones the row `RECONCILE_MISSING` in
  every lane, so the next reconcile revives a transient miss.
- `searchUidsSince` and `searchUidsBefore` use the same UID SEARCH, never one
  FETCH line per message.
- The history-lane archive check from supamail#194 is removed.

## Consequences

- Deletions of mail of any age are mirrored on the folder's normal reconcile
  cadence (about 6 hours, earlier on a dirty signal), with history on or off.
- Lane labels no longer affect deletion correctness. A host that skips the
  expiry job no longer loses mail at the cutoff, and existing false tombstones
  heal on each folder's next reconcile.
- Each reconcile reads the whole folder's UID list instead of only the window's.
  At about 7 bytes per UID on the wire, a 100,000-message folder costs about
  700 KB per reconcile. The FETCH line per window message that the old stream
  cost is gone.
- A provider whose SEARCH count never matches SELECT's count keeps every row
  and reports `RECONCILE_INCOMPLETE` on every reconcile, rather than guessing.
- Reconcile tombstones and revivals do not call `onMessageUpsert`, as tombstones
  never did; hosts follow `deleted_in_provider` in the database.
- Folder-missing tombstones are unchanged and still cover `IN_WINDOW` rows only;
  extending them changes which rows the 30-day purge removes.
