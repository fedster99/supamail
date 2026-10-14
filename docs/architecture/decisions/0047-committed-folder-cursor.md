# ADR 0047: Each Pass Reports and Stores the Folder Cursor It Proved

Status: Accepted

Date: 2026-10-12

## Context

A host that keeps a persistent listener compares each folder's provider status
with what the mirror holds, and schedules a pass when they differ (ADR 0031,
ADR 0032). That comparison is only as good as the cursor it compares against.

Three gaps made the cursor weaker than the mirror:

- A pass takes at most 20 incremental batches of new UIDs per folder and stores
  the UIDNEXT it reached, but its change-feed observation carried the UIDNEXT
  that SELECT reported. After a bulk move, a host that adopted the observation
  stopped seeing the rest of the new mail until the next audit.
- `imap_folders` stored no MESSAGES or UNSEEN. A listener that starts or
  reconnects cannot tell an expunge from no change unless a deletion-complete
  QRESYNC cursor still matches, so it reconciled every other folder once.
- The observation spread ImapFlow's mailbox object, whose `unseen` is SELECT's
  `[UNSEEN n]`: the sequence number of the first unseen message, not a count.

## Decision

- **The observation is the stored cursor.** `markFolderSynced` returns the
  folder's committed cursor after its write, and the observation carries it:
  UIDVALIDITY, the UIDNEXT the pass reached, and the committed MESSAGES,
  UNSEEN, and HIGHESTMODSEQ. A field the mirror cannot vouch for is absent.
  `reconcileComplete` means the pass proved MESSAGES for the stored UIDNEXT;
  `flagScanComplete` means it completed a flag scan or QRESYNC flag replay.
- **Every pass reports every cursor it stored.** The engine calls
  `acknowledgeMailboxChangesWithStatuses(changes, observations)` with an
  observation for each folder whose first sync is complete, including folders
  no provider change named and passes that acknowledge no change. A host that
  keeps its own copy of the cursor therefore never falls behind the database.
  Public core's own IDLE session maps observations to its acknowledged changes
  and ignores the rest.
- **`imap_folders` stores committed MESSAGES and UNSEEN** (migration 0033,
  additive), written by the same per-field rule the listener applies:
  - MESSAGES advances to SELECT's count when the pass checked deletions (a
    clean reconcile or a complete QRESYNC replay) and fetched every new UID
    below the UIDNEXT it stores, so the committed count describes exactly the
    folder below the committed UIDNEXT.
  - A pass that mirrors new UIDs without that proof clears MESSAGES. One
    arrival and one expunge leave MESSAGES unchanged; keeping the old count
    would make the folder look unchanged while the mirror still holds the
    expunged row.
  - UNSEEN advances only after flag work that covered the mirror's flag window
    (a QRESYNC or CONDSTORE delta, an unchanged CONDSTORE cursor, or a
    whole-window scan), to the value the host observed before the pass
    (`MailboxChange.observed.unseen`). The pass has no count of its own: SELECT
    reports none. A routine scan of recent mail commits nothing.
  - A UIDVALIDITY reset clears both, with the rest of the folder's sync state.
  - A field with no committed value counts as different to a host comparing
    against it, so the matching reconcile or flag scan runs.

- **No arrival-only proof.** The spec this follows also proposed proving
  MESSAGES when it equals the committed count plus the new UIDs. That needs
  SELECT's MESSAGES and UIDNEXT from one snapshot, with no new UID expunged
  before the incremental SEARCH. ImapFlow reuses an already selected mailbox
  without SELECT (stale UIDNEXT, live EXISTS), and the SEARCH can see a UID
  above SELECT's UIDNEXT, so the equation can hold while an older message is
  gone. Without QRESYNC, a pass that only fetched new mail therefore leaves
  MESSAGES unproven, and the next comparison asks for an audit.

## Consequences

- After a capped pass the host sees UIDNEXT still differ and schedules the next
  pass, so a bulk move finishes within passes instead of waiting for the audit.
- A host can load committed cursors on start or reconnect and compare every
  field, so an unchanged folder needs no pass.
- Hosts receive observations for folders they did not report. A host that keys
  its cursor by path must ignore paths it does not track.
- The first pass to prove each folder after the upgrade writes its committed
  values; until then hosts see those fields as different once.
- Public core's own Inbox IDLE session keeps seeding reconnect from UIDVALIDITY,
  UIDNEXT, HIGHESTMODSEQ, and the QRESYNC cursor, as ADR 0032 describes.
- UNSEEN is a change detector, not a proof: a read and an unread can cancel.
  With CONDSTORE, HIGHESTMODSEQ is the flag proof. Without it, flags keep the
  flag-scan schedule as their bound.

## Verification

- Live-DB integration tests: a pass capped at its incremental batch limit
  acknowledges and stores the UIDNEXT it reached, and the next pass the rest;
  MESSAGES is committed after the first audit, cleared by a pass that fetched
  new mail without an audit (an expunge hidden behind an arrival), restored by
  the audit, not committed by an audit in a capped pass, and cleared when new
  UIDs arrive without UIDNEXT; UNSEEN comes only from the host's observation
  after window-covering flag work, never from SELECT's `[UNSEEN n]` or a
  routine recent-mail scan; a full pass reports every committed folder; a
  UIDVALIDITY reset clears both.
- The fixture IMAP client reports SELECT's `[UNSEEN n]` as ImapFlow does.
- `public-migrations.live-db.test.ts` applies the migrations twice.

## References

- ADR 0031, ADR 0032.
- `apps/api/src/sync-engine.ts` (`syncFolder`, `syncAccount`), `repository.ts`
  (`markFolderSynced`, `handleUidValidityReset`), `imap-client.ts`
  (`MailboxChangeObservation`).
- Migration `0033_folder_committed_status.sql`.
