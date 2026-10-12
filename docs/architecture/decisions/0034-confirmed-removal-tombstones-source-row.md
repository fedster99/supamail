# ADR 0034: A Confirmed Move Or Delete Tombstones Its Source Row

Status: Accepted; amended by ADR 0037 for moves the server confirms with COPYUID

Date: 2026-10-05

## Context

ADR 0018 kept moves and deletes provider-authoritative: after a confirmed
`MOVE` or UID `EXPUNGE`, the source row stayed live until the next reconcile of
its folder. Draft update and send delete the previous draft through the same
`deleteMessage`, so the gap became visible once ADR 0033 returned a new draft id
at once. In production, after an update that returned `replacedDraftDeleted:
true`, `getDraft` still returned the replaced draft and `listDrafts` still listed
it for one to two minutes. In that window `deleteDraft` on the old id "succeeded"
against a UID that no longer existed, and `updateDraft` on the old id filed yet
another draft, so a caller reusing a stale id created duplicates.

The source row is a known row, and the provider has confirmed that its UID left
its folder. Within one UIDVALIDITY a UID is never reused, so marking that row
deleted is a deterministic write of a known value, like the flag write-through,
not a guess.

## Decision

After the provider confirms the action, `deleteMessage` (hard and Trash),
`moveMessages` (and `moveMessage`), and each member of `moveThread` mark exactly
that source row
`(account_id, folder_path, uidvalidity, uid)` as `deleted_in_provider` with
`deleted_reason = 'PROVIDER_DELETED'`.

- **Reason.** `PROVIDER_DELETED` already exists in the schema and is not in the
  purge set, so the row keeps the same retention as the `RECONCILE_MISSING` row
  reconcile would have written. No migration.
- **Any window status.** The write does not depend on `IN_WINDOW`. Reconcile
  covered only in-window rows when this was written (ADR 0038 later extended it
  to every lane), so a removed historical message could stay live in the mirror.
- **Never fails a confirmed action.** The provider action has already happened.
  If the mirror write fails, the call still succeeds and logs a warning; the
  folders are already due, and reconcile tombstones the row instead.
- **Destination is not guessed.** A moved message's new row arrives with the
  destination folder's sync, as before. Until then the message is absent from
  reads rather than shown in the folder it left. This is the state reconcile
  would reach anyway when the destination, such as Trash, is not tracked.
- A Trash delete of a message already in Trash, or a move to the folder a
  message is already in, does nothing: no provider command and no write.

## Consequences

- After a move, delete, draft update, or draft send, the old id is not found at
  once. A second update or delete by that id throws `NotFoundError` and files
  nothing.
- A sync that read the UID before the action and writes after it can revive the
  row as live. The folder is already due, so the next reconcile tombstones it
  again; this is the same self-healing race ADR 0018 accepts for flags.
- Reconcile finds fewer gaps for these folders, because the row is already
  tombstoned.

## Verification

- `mailbox-mutations.test.ts`: hard delete, Trash delete, move, and thread move
  tombstone the exact source row after the provider confirms; a failed provider
  action, a no-op Trash delete, or a same-folder move writes nothing; a failed mirror write still
  returns success.
- `drafts.live-db.test.ts`: against real Postgres, with only IMAP faked, a hard
  and a Trash draft delete tombstone the row with `PROVIDER_DELETED` and drop it
  from `getDraft` and `listDrafts`; after an update the replaced id is not found,
  and a second update by it throws `NotFoundError` without filing a draft.

## References

- ADR 0018: organize mutations and the flag write-through; this ADR revises its
  rule that moves and deletes leave the mirror to reconcile.
- ADR 0033: the saved draft's mirror row.
- `apps/api/src/mailbox-mutations.ts` (`writeRemovalThrough`),
  `apps/api/src/repository.ts` (`markMessageRemovedByProvider`).
