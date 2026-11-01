# ADR 0045: A keyed draft save happens once

Status: Accepted

## Problem

A `save_draft` retried with the same idempotency key filed a second draft. Core
checked for a prior save with `SEARCH HEADER Message-ID`, and a provider's
SEARCH index can trail a fresh APPEND: on Purelymail a just-filed draft was not
found for 16.5 s in one probe and was still missing after 25 s in another. Three
failures followed in production on 2026-10-19:

- a retry within the lag filed a duplicate draft with the same Message-ID;
- the same key with changed text filed a second draft instead of failing;
- a retry after the draft was sent filed it again, so a later send would send
  the email twice.

## Decision

Two parts, one rule: a keyed draft save happens once.

1. `SentFolderAppender.findByMessageId` reads the Message-ID header of the
   folder's 50 newest messages by FETCH before it falls back to SEARCH. FETCH
   sees an APPEND at once. Saves to one mailbox run under its account lock, at
   most about one per second, so a retry inside any SEARCH lag finds its copy
   among the newest. SEARCH still covers a retry long after the save.
2. `runDraftSaveOperation` and `replayDraftSaveOperation` in
   `send-operations.ts` record a keyed save in the host's `SendOperationStore`
   (ADR 0041) under action `save_draft`. A recorded save returns its result
   without provider work, even after the draft was sent or deleted. The same key
   with a changed request, mailbox or action is `idempotency_conflict`.

A draft save, unlike SMTP, is safe to run again: its Message-ID comes from the
key and part 1 finds an earlier copy before APPEND. So an attempt that recorded
no result simply runs again. There is no unknown outcome and no
`operation_in_progress` wait after a crash.

## Scope and limits

The store records the request before filing, so even after a crash a retry
with changed details is a conflict. The built-in HTTP API keeps its
`Idempotency-Key` draft create with part 1 only: there, a retry with changed
details returns the earlier draft. A self-hosted application that supplies a
store gets part 2. The window of 50 assumes no other client files dozens of
drafts in seconds.

## Validation

`smtp-client.test.ts` covers the newest-first lookup and its SEARCH fallback;
`send-operations.test.ts` covers record, replay, conflict, rerun after an
unrecorded attempt and storage failure. A live probe on a Purelymail mailbox
found a fresh APPEND with the new lookup while SEARCH returned nothing.
