# Reliability Invariants

This is the agent-readable reliability contract distilled from `docs/spec-conformance.md`, the code, and public architecture decisions. Use it before touching sync, repository, schema, lock, health, or migration behavior.

## Identity And Storage

- Message identity is scoped by `(account_id, folder_path, uidvalidity, uid)`.
- This is mailbox-row identity only. Do not add CRM identity hydration, person/company resolution, handle mapping, or activity construction to SupaMail core.
- Never treat IMAP UID as globally unique.
- Store raw and normalized Message-ID separately.
- Full MIME/body data belongs in `imap_message_bodies`; message list rows stay metadata-oriented.
- Attachment metadata is stored during sync; binary attachment fetching is not part of the current core path.
- Body backlog draining is capped per tick so recent-body work cannot consume the whole lock window forever.

## Concurrency And Connections

- One IMAP operation per account at a time across worker and API.
- Use session-scoped Postgres advisory locks, not transaction locks.
- `DATABASE_URL` must be direct or session-affine. Transaction poolers are unsafe for this architecture.
- Worker startup must fail if advisory lock self-test fails.
- Stale lock recovery must be heartbeat-based and conservative.
- `MAX_LOCK_HOLD_MS` is a cooperative fairness budget. It is checked at safe boundaries, not by killing in-flight IMAP commands.
- Priority folders may finish past the lock budget; non-priority folders and body batches stop at the next safe boundary.
- A `hitLockBudget` cycle is normal completion and must not reset backoff counters.

## Folder And UID Semantics

- Folder discovery must not treat one empty or missing `LIST` result as authoritative deletion.
- Missing folders get a grace period before being marked `MISSING` and tombstoning in-window rows.
- Exclude dangerous/system folders such as Spam/Junk, Trash/Deleted, Drafts, and All Mail by default.
- Do not exclude Archive by default.
- UIDVALIDITY changes invalidate prior UID references for that folder.
- UIDVALIDITY reset must soft-delete old in-window rows, reset folder sync state, and eventually mark pathological accounts `BROKEN`.

## Sync Semantics

- Initial sync is folder-level, snapshot-based, newest-first, and resumable.
- Initial sync SEARCH/FETCH work is bounded by `INITIAL_SYNC_BATCH_TIMEOUT_MS`; a timeout aborts the IMAP client and must not advance the initial-sync watermark.
- A failed initial sync batch must not advance watermarks.
- Incremental sync only advances `last_uid` after all fetched metadata for the batch succeeds.
- Partial metadata fetches are hard failures. Do not swallow per-message errors and advance cursors.
- Flag scans are due-based and compare normalized flags.
- Reconcile only runs after initial sync is complete for the folder.
- Reconcile must handle both sides: mark provider-missing local rows and backfill missing-in-DB provider UIDs.

## Health And Backoff

- Health must not lie.
- Accounts remain `INITIAL_SYNC` while tracked folders are incomplete.
- Accounts remain or become `DEGRADED` when priority lag, reconcile drift, folder missing, UIDVALIDITY reset, or timeout semantics require it.
- Long-stuck `DEGRADED` accounts with no priority success escalate to retryable `BROKEN` (`STUCK_DEGRADED_24H`) and then terminal `BROKEN` (`STUCK_DEGRADED_TERMINAL`) if recovery keeps failing.
- `AUTH_ERROR` is non-retryable and pins the account `BROKEN`.
- `PARTIAL_SUCCESS` increments success counters only when priority folders succeeded and round-robin folders failed.
- Backoff must be conservative, jittered, and reset only after stable success.

## Retention And Safety

- Expiry marks old rows `EXPIRED`; it does not hard-delete them.
- Purge is a strict safety valve for trapdoor delete reasons only.
- Do not purge `RECONCILE_MISSING` rows.

## Verification Anchor

If a change touches any invariant in this document, run the heavy reliability gate:

```bash
pnpm test:db:live
```
