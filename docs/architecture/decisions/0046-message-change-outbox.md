# ADR 0046: A Trigger-Written Change Outbox For Mirror Messages

Status: Accepted

Date: 2026-10-13

## Context

Public `0011` indexes `imap_messages (updated_at, id)` so a consumer can find
changed messages by an `(updated_at, id)` cursor. Every update sets
`updated_at` (`imap_mirror_set_updated_at`), so every update changes an indexed
column, and PostgreSQL can never make it a heap-only (HOT) update: each flag
change, body completion, or move writes a new entry in every index of the
table. A hosted deployment measured 0 HOT updates out of 135,247.

The cursor is also unsound on its own: `updated_at` is the writer's transaction
start time, so a transaction that commits after a later one is behind the
cursor once it becomes visible.

## Decision

**A statement trigger on `imap_messages` writes each update of a live message to
`imap_message_changes` in the writer's transaction. A consumer reads rows and
deletes the ones it handled.**

- `imap_message_changes (id, account_id, message_id, changed_at)`. `id` is an
  identity, so a consumer reads in insertion order. `account_id` cascades from
  `imap_accounts`; `message_id` has no foreign key, so a consumer skips a row
  whose message is gone.
- `AFTER UPDATE ... FOR EACH STATEMENT` with a `NEW TABLE` transition table
  inserts one row per updated row that is not deleted in the provider. Inserts
  are not recorded: a consumer finds new mail by `(created_at, id)`. A deletion
  is not recorded; a restore is.
- The function is `SECURITY DEFINER`, like the threading evidence outbox, so a
  writer needs no rights on the table. Every writer is covered: sync, a flag or
  move an API or MCP action writes through, and a host's own writes.
- A consumer deletes what it claimed after it has durably handed it on.
  Claiming by deletion, not by a cursor, means a row that commits late is
  still read on the next pass.
- `runMessageChangePruneJob` (part of `runRetentionJobs`) deletes rows older
  than seven days, so the table stays bounded where nothing consumes it.

## Consequences

- With no consumer of `(updated_at, id)` left, a later reviewed removal can
  drop `imap_messages_updated_emit_idx`, making updates that touch no other
  indexed column HOT-eligible.
- Each update of a live message adds one small insert and, once claimed or
  pruned, one delete. That is much less than a non-HOT update's index entries.
- A consumer stopped for more than seven days loses the changes before that.
- `updated_at` itself is unchanged.
