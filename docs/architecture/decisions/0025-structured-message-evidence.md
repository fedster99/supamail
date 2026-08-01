# ADR 0025: Decode Structured Message Evidence Without Clustering It

Status: Accepted

Date: 2026-07-14

## Context

Downstream products need stable document, calendar-instance, and provider-resource
identities to connect separate protocol conversations about one task. Filename, size,
subject, and body similarity are not identities. The mirror sees decoded attachment
bytes and MIME bodies during fetch, including in `parsed_only` mode, but previously
discarded that exact evidence after parsing.

SupaMail must preserve its boundary: delivery identity and reply conversations belong
in the public core; application-specific semantic grouping does not.

## Decision

- MIME parsing emits bounded neutral evidence rows for decoded attachment SHA-256,
  iCalendar `UID` + `RECURRENCE-ID` instances, and strict canonical resource URLs for
  GitHub issues/pulls, Google Drive files, Jira issues, and DocuSign envelopes.
- `imap_message_evidence` stores the raw bounded key for explanation and a fixed-size
  SHA-256 key for joins. It records kind, namespace, metadata, extractor, and extractor
  version. It never stores decoded attachment bytes or arbitrary URLs/query tokens.
- A complete fetch atomically upserts current evidence and removes stale rows from the
  same extractor. The body row records extraction version, deterministic evidence
  digest, completion, and attempt time. Truncated fetches are attempted-but-incomplete,
  retain no accepted digest, and are not retried forever.
- Existing live/history body lanes select rows whose extraction version is missing, so
  rollout backfill remains bounded by the established account lock, batch, and history
  settings. `lazy` and `metadata_only` policies remain authoritative and do not force a
  body fetch merely for evidence.
- SupaMail makes no `same_work_item` decision. Exact attachment bytes identify a file,
  not a task; one calendar UID may have many occurrences; a resource identifier proves
  a shared external resource, not a reply relationship. Downstream consumers must keep
  these separate from `imap_thread_assignments.conversation_id` and apply their own
  versioned, reversible policy.

## Consequences

Structured evidence survives `parsed_only` storage without retaining raw MIME. New and
re-fetched messages are immediately usable by downstream candidate generation; older
messages converge through bounded backfill. Consumers can explain and recompute joins,
while reusable templates, forwarded documents, and repeated subjects cannot silently
become protocol conversation truth.
