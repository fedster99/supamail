# ADR 0028: Commit Content Evidence Before Body Storage

Status: Accepted

Date: 2026-07-23

## Context

Search and conversation threading were derived from the full parsed body row.
That coupled both features to database body retention and made another durable
body store impossible without either losing search/threading or reading the
full payload back during indexing and projection work.

The seam must preserve current OSS behavior, including `BODY_STORAGE_MODE`,
while making search and threading independent of later payload readability.
Existing mirrors must become searchable through the new representation without
a mailbox re-sync.

## Decision

- The search extract is the parser's selected normalized plain text
  (`bodyText`: plain MIME preferred, otherwise HTML converted to text), capped
  at exactly 32 KiB of UTF-8 without splitting a code point. HTML, raw MIME,
  attachment bytes, and headers do not enter the extract.
- `imap_message_bodies.search_extract` is Postgres evidence, not full payload.
  FTS, body filters, and snippets use this extract. A GIN expression index
  avoids retaining a second stored copy as a generated `tsvector`; fuzzy recall
  remains on the existing bounded header trigram indexes.
- Sync commits the search extract, recovered threading headers, structured
  evidence, a SHA-256 over every parsed payload variant, and the
  raw/parsed/authored delivery digests in one transaction before invoking
  `BodyStore.store`.
- `threading_payload_sha256` is compact evidence over parsed text, HTML, plain
  text, selected part, and selected format. New writes compute it while decoded
  MIME is available. Envelope corrections can recompute their delivery
  projections from this digest and retained headers/MIME evidence without
  reading the body payload. The bounded legacy repair lane stays only for rows
  created before this seam.
- After the evidence transaction commits, the injected `BodyStore` receives the
  full `MessageBodyInput`. Only after it succeeds does the repository set
  `imap_messages.body_fetched_at` and advance the folder body counter.
- In `parsed_only`, the body lane can request at most 10 known-complete,
  same-folder messages of at most 4 MiB each with one UID-set FETCH, with an
  8 MiB aggregate source cap. The fetch and parse complete before body storage,
  so storage latency never pauses an active IMAP command. The loop issues no
  nested IMAP command. Larger, unknown-size, singleton, and cap-limited messages
  use the streaming download path. This fast path does not change the evidence
  → store → completion order.
- `DatabaseBodyStore` is the OSS default. It stores parsed text, HTML, selected
  part data, and raw MIME exactly as before; `BODY_STORAGE_MODE=parsed_only`
  continues to store `raw_mime = NULL`.
- `MirrorRepository.storeBody` remains as a backward-compatible database-store
  convenience. The sync engine uses the explicit evidence → store → completion
  sequence.
- Migration `0022_content_extract_body_store` backfills existing extracts from
  `body_text` (with `body_plain` as the legacy fallback) and the compact
  threading payload digest from all parsed variants. It adds the new FTS
  expression index and keeps compatibility triggers for pre-0022 rolling-deploy
  writers. It does not delete the older body indexes or payload columns.
- An evidence row alone is not body completion. Live and priority coverage also
  require `body_fetched_at IS NOT NULL` and `raw_truncated = false`.

## Consequences

Search indexes and conversation projections can be rebuilt without reading a
body payload. A body-store failure leaves useful search/threading evidence but
keeps the message in the normal body backlog; retries are idempotent.

For a 40-body tick, the worker reads the database backlog
once and uses four bounded UID-set FETCH commands instead of 40 preflight
FETCHes plus 40 downloads. The single-message fallback also avoids the old
parsed-only preflight FETCH. This improves one connection without adding
parallel body writes or weakening crash recovery.

The database store remains byte-compatible for OSS users. This ADR introduces
no object-storage provider, hosted search backend, retention policy, or
multi-tenant behavior. Those belong outside public core or in separately
accepted work.

Existing mirrors pay bounded extract/threading-digest backfills and one new
index build when they apply migration 0022. Full payload columns and their old
indexes remain for compatibility; removal is not part of this seam.

The 32 KiB prefix is an explicit storage/recall tradeoff, not an assumption that
all mail is shorter. In a measured 43,129-body corpus, 1,659 bodies (3.85%)
exceeded the bound. The extract-only search evaluation therefore runs through
the same truncation function, and terms present only after the prefix are
intentionally outside the retained search contract. Keeping the prefix simple
also avoids over-representing quoted history commonly found at message tails.

## Verification

- Unit tests pin the 32 KiB UTF-8 bound, database default adapter, SQL compiler
  cutover, and source-level operation order.
- Live-DB integration observes committed search/thread evidence with every full
  payload field still NULL when the body store is called, and confirms progress
  remains incomplete until store completion.
- Threading live-DB coverage removes every full payload column and proves two
  physical copies still share one delivery and conversation.
- Public migrations apply twice; live-DB, threading, and spec-conformance gates
  pass.
- `eval:search` matches the pre-seam headline nDCG@10 and passes all four junk
  guards.

## References

- `apps/api/src/body-store.ts`
- `apps/api/src/repository.ts`
- `apps/api/src/sync-engine.ts`
- `apps/api/src/search/compile.ts`
- `apps/api/supabase/migrations/public/0022_content_extract_body_store.sql`
- `docs/architecture/decisions/0015-search-layer.md`
- `docs/architecture/decisions/0024-durable-conversation-threading.md`
- [ImapFlow fetching API](https://imapflow.com/docs/api/imapflow-client/#fetchrange-query-options)
