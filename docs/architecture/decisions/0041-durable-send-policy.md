# ADR 0041: Shared durable send policy, host-owned storage

Status: Accepted

## Problem

A provider can accept SMTP DATA before the client loses the response. Neither a
stable Message-ID nor an account lock prevents a later retry from sending the
same email again. A durable operation record must govern that retry. Requiring
each host to implement this state machine duplicates an email reliability rule.

## Decision

Core exports `runSendOperation` and `replaySendOperation` from
`apps/api/src/send-operations.ts`. A host supplies a `SendOperationStore`, its
existing send primitive, and optional operation-specific Sent reconciliation.
The module contains the existing hosted policy; no queue or service is added.

- Claim the operation durably before calling the send primitive.
- Return stored success without sending or looking up an old draft again.
- Reject reuse of a key with a different request, action, mailbox or Message-ID.
- Retry only typed errors that prove no submission, or SMTP `not_delivered`.
- Never submit again after an unknown outcome. An abandoned claim becomes
  unknown, not retryable. A provider receipt or specific Sent evidence can prove
  success even if writing the final ledger result fails.

Storage owns atomic claims, scope, persistence and crash-expiry timing. The host
must retain records for the retry lifetime and keep the expiry above its maximum
valid submission time (the hosted default is 15 minutes, above the core SMTP
DATA timeout of 10 minutes). The supplied store must preserve a completed success
against late writes. A single in-memory Map is not a production adapter.

The hash algorithm, key validation, statuses, error codes and transition events
stay compatible with existing hosted records. Key validation also occurs at
both exported operation boundaries. Pre-submission classification uses core
error classes, not matching provider text or trusting an arbitrary error name.

Authorization, customer scope, database schema and credentials stay with the
host. Existing hosted records stay in place. Draft sends must not use a Sent
lookup based on the draft's original Message-ID: another send can share that ID.
A reconciler must prove this operation's delivery, not just find similar mail.

## Scope and limits

This is a library boundary, not a new sending endpoint. `sendMessage`,
`sendDraft`, the CLI and HTTP API retain their current contracts; calling the
raw primitive alone is still not retry-safe. A self-hosted application can use
the exported policy with durable storage. This change does not automatically
add a ledger to the built-in CLI or HTTP API, or enable sending through MCP.

The host still determines request identity before dynamic reply composition or
attachment lookup. No message body is persisted by this module. Stored results
can contain provider receipts and recipient addresses; hosts must protect them.
Exactly-once delivery is not promised: unknown delivery may remain unknown.

## Validation

`send-operations.test.ts` covers concurrent calls, changed requests, restart
replay, typed failure classification, lost SMTP replies, storage failures,
operation-specific Sent recovery, stale claims and late completion writes.
The host's adapter additionally requires real-database concurrency and isolation
proofs. Adoption by a host requires these tests with the published core module.
