# ADR 0036: Folder Message Counts Are Kept By Statement Triggers

Status: Accepted

Date: 2026-10-05

## Context

`list_folders` counted every row of `imap_messages` on each call: one
`GROUP BY` per folder, then a second full pass for account totals. Its cost
grew with the mailbox, not the folder count, and large mailboxes made the
call slow at the tail. Hosts that show a mailbox total ran the same full count.

The only stored per-folder count, `headers_synced_count`, is sync progress. It
rises when new rows are inserted and never falls on a delete or move, so it
cannot serve as a live count.

## Decision

- `imap_folder_message_counts`, keyed by `(account_id, folder_path)`, holds
  each folder's live (`deleted_in_provider = false`) messages and those without
  `\Seen`. Its account key cascades with the account.
- Three statement-level `AFTER` triggers on `imap_messages` (insert, update,
  delete) read the statement's transition tables. Each live row after the
  statement adds one and each live row before it subtracts one. Only folders
  whose net change is non-zero are upserted, once per statement, in key order
  so multi-folder statements cannot deadlock each other. A statement that
  changes no count writes nothing.
- The trigger runs in the writer's transaction with the writer's rights, so
  every writer, including the sync engine, mailbox mutations, hosts, and manual
  SQL, keeps the counts exact. No write path carries counter code, and no
  reconcile pass repairs counts.
- The counts are not columns on `imap_folders`. Sync locks the folder row
  before it writes messages, while a user flag change locks its message first;
  a counter on the folder row would make those two wait on each other. The
  counts row is locked only by the trigger, at the end of a statement.
- Migration `0028` creates the table and backfills it once, under `LOCK TABLE
  imap_messages IN SHARE MODE`, in the same transaction that creates the
  triggers, so no write lands between the count and the first counted change.
- `list_folders` reads folder rows joined to their counts on
  `(account_id, path = folder_path)` and sums the listed folders for totals.
  Every tracked folder is listed, including empty ones; an untracked (excluded
  or missing) folder is listed while it still holds live mail. The
  `flagged` total is removed: no caller used it, and keeping it would add a
  third counter.

## Consequences

- `list_folders` costs one indexed read per folder, independent of mailbox size.
- Every `imap_messages` update statement pays the trigger: within noise for a
  single-row update that changes no count and about 0.07 ms for a flag change on
  a 500k-row table in the lab, and within noise for a 500k-row bulk update.
- Writers that change counts in one folder serialize on its counts row from the
  end of their first counting statement until commit.
- Deadlock freedom rests on one rule: a transaction that changes counts in more
  than one statement locks every message row it will write before its first
  counting statement, and changes counts in one folder. `upsertMessages` and
  `applyFlagScan` do; a new multi-statement writer must too.
- A `REPEATABLE READ` or `SERIALIZABLE` writer can fail with a serialization
  error when another transaction changed the same folder's counts after its
  snapshot. No core message writer uses those levels.
- Hosts that add row-level security must let every writing role select,
  insert, and update the counts table and see its own accounts, and must keep
  the unique key `(account_id, folder_path)`, because the trigger runs with the
  writer's rights and upserts on that key. A write that changes no count does
  not touch the table.
- Triggers do not fire under `session_replication_role = replica` or for
  `TRUNCATE`, and a data-only restore with triggers on counts restored rows
  again. After such a restore, recompute in one transaction:
  `LOCK TABLE imap_messages IN SHARE MODE`, delete every counts row, then insert
  the migration's backfill query. Hosts that add columns to the counts table
  fill them in the same insert.

## Verification

- `list-folders.live-db.test.ts`: counts after inserts, flag changes, null
  flags, tombstones and restores, a multi-folder move in one statement, and a
  hard delete equal a fresh count for every folder; a count-changing write
  finishes while another transaction holds the folder row locked; an account
  delete removes its counts; a write that changes no count does not wait on an
  open count change; empty tracked folders are listed, and untracked ones only
  while they hold mail.
- `schema.test.ts`: the migration creates the table, backfills under the lock,
  and creates three statement triggers without touching `imap_folders`.
- `list-folders.live-db.test.ts` also drops the table, migrates over existing
  mail, and migrates again: the counts equal the counts before.
- `sync-engine.integration.test.ts` asserts after every test that the stored
  counts equal a fresh count, covering UIDVALIDITY resets, tombstone restores
  through upserts, flag scans, and reconcile.
- `pnpm test:db:live` applies the migration twice.
