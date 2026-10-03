# ADR 0033: A Saved Draft Writes Its Own Mirror Row From APPENDUID

Status: Accepted

Date: 2026-10-03

## Context

ADR 0019 had create and update file the draft in the provider and insert no
mirror row: the next sync of Drafts mirrored the copy, so the caller got no
mirror id. Hosts saw the cost in production. Agents save a draft and then update
or send it within seconds, but the id appeared only after the next Drafts sync,
a median of 14 seconds and up to 46 seconds later. Every update, send, or delete
in that window had no id to use.

The ADR 0017 rule behind this is that identity is never guessed. APPENDUID
(RFC 4315) is not a guess. It is the server's own statement of
`folder + UIDVALIDITY + UID` for the bytes just filed. A host could ask the
worker to reconcile Drafts and wait, but that adds a cross-process call, a
wait, and a second account-lock holder for a value the save already holds.

## Decision

After a provider-acknowledged draft APPEND returns APPENDUID, `createDraft` and
`updateDraft` write the draft's mirror row through the sync's own
`upsertMessages`, under the account lock the save already holds, and return
its id as `messageId`. The lock fences its writes, as sync's does, so a save
that lost the lock cannot overwrite a row that sync already read. The write has
a 5-second deadline, so it cannot hold the lock or the caller's request long.

- **Values the save knows.** UID and UIDVALIDITY come from APPENDUID. The
  Message-ID, In-Reply-To, References, subject, sender, To, Cc, size, flags
  (`\Draft \Seen`), and internal date come from the composed request and bytes.
  `headers_json` keeps the same header subset that sync stores. The save does
  not read from the provider, so ADR 0017's "the send path never read-syncs"
  still holds.
- **Values only the server knows stay empty.** These are BODYSTRUCTURE,
  attachment parts, and provider object/thread ids. The body arrives through the
  normal body lane, as for any new message. A parsed-only body fetch for a row
  with no BODYSTRUCTURE asks the server for it and for RFC822.SIZE in the same
  session. Body-part selection then never runs without a structure, and the
  truncation check uses the server's size, not the composed size.
- **Sync stays authoritative.** The write leaves the folder's `last_uid`
  unchanged. Drafts is marked due before the APPEND, so the next sync of Drafts
  reads the UID again, replaces the saved values with the server's view through
  the same upsert, and keeps the row id.
- **Narrow guard.** The save writes the row only into a Drafts folder that is
  tracked, not missing, and already holds the APPENDUID's UIDVALIDITY from sync.
  Sync reads a UID above `last_uid` again in both incremental sync and the
  initial sync's new-mail batch. Without
  APPENDUID, without such a folder, or after a failed write, `messageId` is null
  and the next Drafts sync mirrors the draft as before. Once the APPEND returns,
  the save confirms the lock's irreversible step, so a failed mirror write or a
  failed lock release is a warning, never a thrown error: the provider already
  holds the draft, and a retry without an idempotency key would file a second one.
- **Retries.** An idempotent retry that finds its earlier copy returns that
  copy's live mirror id, if one exists. It does not write a row, because the
  earlier attempt's bytes may differ from this request's.

Sent APPENDs (ADR 0017) are unchanged and still insert no row.

## Consequences

- Hosts get a usable draft id in the same response. A get, update, send, or
  delete works at once. Send already fetches the raw bytes on demand, so it does
  not wait for the body lane.
- Until the next Drafts sync, a saved draft has no attachment rows, provider
  ids, or BODYSTRUCTURE, and reads show no attachments for it. Its body is
  `null` until the body lane stores it, so a read right after the save shows the
  body as not mirrored yet.
- The new draft shows in `listDrafts` at once. Deletes stay
  provider-authoritative (ADR 0018), so after an update the replaced draft can
  also show until reconcile, as it did before this change.
- `headers_synced_count` counts the row once. Sync's later re-read finds the
  existing row and does not count it again.

## Verification

- `drafts.test.ts`: the row is written after the APPEND from the APPENDUID and
  the composed values, with the sync's header subset, under a write-fenced lock
  and a short deadline; no APPENDUID, an untracked
  or unread Drafts folder, or another UIDVALIDITY writes nothing; a failed write
  is a warning and the save still succeeds; an idempotent retry returns the
  earlier copy's id; update returns the new id.
- `drafts.live-db.test.ts`: against real Postgres, a saved draft is readable at
  once by its id, and a later sync upsert of the same UID keeps the id, applies
  the server's values, and leaves `headers_synced_count` at one.
- `imap-client.test.ts`: a parsed-only body fetch, single or batched, for a row
  with no BODYSTRUCTURE selects its text part from the server's.
- GreenMail smoke: a draft is saved and updated by its id before any sync; the
  revised draft is readable at once; the next real sync keeps its id and fills
  BODYSTRUCTURE; sending it delivers the body.

## References

- ADR 0017: the write-only appender and "identity is never guessed".
- ADR 0018: flag write-through of known values; deletes stay
  provider-authoritative.
- ADR 0019: draft CRUD; this ADR supersedes its "no mirror row" rule for draft
  create and update.
- RFC 4315 (UIDPLUS) §3: APPENDUID.
- `apps/api/src/drafts.ts` (`saveDraft`, `mirrorSavedDraft`,
  `savedDraftMetadata`).
