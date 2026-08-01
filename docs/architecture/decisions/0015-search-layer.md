# ADR 0015: Search Is a Pure-Postgres Read Layer With an Opt-In Semantic Tier

Status: Accepted

Date: 2026-06-07

## Context

Issues #4 (MCP server) and #7 (agent-first CLI) both need search over the mirror.
ADR 0014 established that agent email access is a first-class core read surface and
that the MCP server and CLI must share **one** read-tool contract. Search is the
flagship read tool behind both. This ADR records how that search is built.

The constraints are fixed by the rest of the product:

- **Public core, per-account Supabase/Postgres.** The search schema ships as a public
  migration that runs unchanged on every self-hoster and customer database. It must
  be additive, idempotent, and safe to re-run (the whole public set is concatenated
  and executed as one implicit transaction by `applyPublicMigrations`, re-applied on
  every boot — see `db.ts`). No `CREATE INDEX CONCURRENTLY` (illegal in a
  transaction).
- **Core scope is email sync only, no AI by default** (AGENTS.md, ADR 0001). A
  semantic/embedding search needs an external embedding model, which the pure core
  must not require to function.
- **Must not weaken sync reliability.** Indexing must not slow the hot write path
  (`upsertMessages`, `storeBody` run every worker tick) or risk deadlocks with the
  account advisory locks.
- **The searchable document is split across two tables** (`imap_messages` holds
  subject/from/to; `imap_message_bodies` holds the body) and **the body arrives
  late** (lazy / priority body fetch).
- **The connection is trusted and server-side** (RLS is bypassed), so `account_id`
  is the only access boundary and must be bound on every search branch.

## Decision

### One injected function, two thin wrappers

Search is a single pure function `searchMessages(db, request)` in `apps/api/src/search/`.
The CLI command (`supamail search`) and the MCP tool (`search_email`) are thin
wrappers that both call it, so the two surfaces cannot drift (ADR 0014). The function
takes the database connection by injection and runs entirely inside a **read-only
transaction** (`SET LOCAL transaction_read_only = on`, a statement timeout, and a
`SET LOCAL` trigram threshold) with every operator value bound as a `$n` parameter.
It emits only `SELECT`. There is no send, mutate, or schedule path.

### Two STORED generated tsvector columns, no trigger, no queue

Because a generated column can only read its own row and the body lives in a sibling
table that fills late, we use **two** `GENERATED ALWAYS ... STORED` tsvector columns:

- `imap_messages.header_fts` — weight A = subject, B = sender, C = recipients.
- `imap_message_bodies.body_fts` — weight D = the HTML-stripped plain body
  (`body_text`, which is `bodyPlain ?? htmlToText(bodyHtml)`).

Generated columns *are* the incremental materialization: `header_fts` recomputes only
when a weighted source column actually changes (and **not** on the flag-only rescan
`UPDATE`, which touches none of them), and `body_fts` recomputes exactly when
`storeBody` writes the body. No trigger, no async queue, no staleness window, and the
one-time backfill is free (adding the column computes it for every existing row inside
the migration). This rejects the alternative trigger/queue designs, which would
amplify the hot write path or add a staleness window for no benefit.

### Search drives off `imap_messages`; the body is JOIN-only

Every query starts from `imap_messages` (the authoritative, account- and
soft-delete-scoped side) and LEFT JOINs `imap_message_bodies`, using `body_fts` only
as a match predicate. We deliberately **do not** denormalize `account_id` or
`deleted_in_provider` onto the bodies table: the SQL-only soft-delete paths never
touch bodies, so a denormalized flag would leak soft-deleted bodies into search.

### Email correctness rules baked into the schema

- **No raw `to_emails` / `cc_emails` array GIN indexes.** Emails are stored verbatim,
  so `to_emails @> ARRAY[:addr]` silently misses mixed-case addresses. All recipient
  matching goes through `lower()` — exact recipient via `EXISTS(unnest ... WHERE
  lower(e) = lower($1))`, fuzzy/substring via a lowercased flattened-recipients
  trigram GIN. The `flags` array GIN is kept (flag tokens are case-exact).
- **Body source capped at 131072 chars (128 KB).** The ~1 MB cap is on the *output*
  tsvector; real prose at 1M chars can overflow and ERROR inside the generated column
  on the hot `storeBody` write. 128 KB is safe headroom and still indexes far more
  body text than any provider exposes.
- **`'english'` config for prose only.** Identifiers (emails, message-ids, filenames)
  go through `pg_trgm` / b-tree and are never stemmed. The query layer parses user
  text with the same `websearch_to_tsquery('english', ...)`.

### Tiers

- **Tier 0 / Tier 1 (this migration, mandatory, 100% pure Postgres):** weighted FTS,
  `pg_trgm` substring/identifier matching, `btree_gin` account-scoped GIN, structured
  b-tree predicates, two-factor relevance ranking (lexical × recency × email-signal
  prior), `ts_headline` snippets, and an honest `sync_trust` block. Dependencies:
  `unaccent`, `pg_trgm`, `btree_gin` only. Deterministic, zero external services.
- **Tier 2 (opt-in, self-gated):** a separate `imap_message_embeddings` table + HNSW
  index, created **only if** the `vector` extension is already installed. The pure
  core never requires pgvector; absent it, the block no-ops and search is FTS-only.
  Embeddings are populated by an out-of-core job (not in this repo). This keeps the
  "no AI in core" boundary intact while leaving a clean hook.

### Structured filters (email-005)

Nylas-parity structured query filters (`messages?subject=&unread=&received_after=…`)
are **not a new engine** — they are additional optional predicates over the same
`searchMessages(db, request)` core, so the differentiator stays the composition: a
structured filter **narrows** the existing semantic + fuzzy free-text query over the
**full** mirror history (no Nylas 90-day window), it never replaces it.

- **One filter union, one compiler.** Every filter — whether it arrives as a `q`
  operator (`from:` `cc:` `is:unread` `after:7d` `in:`) or as a typed `filters`
  object field (`from`, `cc`, `bcc`, `anyEmail`, `isUnread`, `isStarred`, `after`,
  `folder`, …) — converges on the same `SearchFilter` tagged union and is turned into
  a **bound** `$n` predicate by the one compiler. No surface builds SQL of its own.
  > Filter fields single-sourced (arch): the per-field rules (kind, value
  > normalization, operator aliases, structured key) live in one declarative table
  > (`search/filter-fields.ts`); `parseQuery` and `filtersFromStructured` both consume
  > it and the schema parity test asserts the table ⟷ Zod ⟷ JSON-Schema key sets agree.
- **email-005 added** the precise recipient lanes the union was missing: `to` (To
  only), `cc` (Cc only), `bcc` (Bcc only — populated only on sent mail), and
  `anyEmail` (from + to + cc + bcc, the Nylas `any_email`). The pre-existing broad
  `recipient` lane (To+Cc, reached via `recipient:`/`participant:`/`with:`) is kept
  for back-compat; `to:`/`cc:` now resolve to their own scoped lanes. `isStarred`
  is an alias of the `\Flagged` flag. State (`unread`/`starred`/`has_attachment`),
  date-range (`received_after`/`received_before`), folder scoping, pagination, and
  ordering already existed and are simply exposed ergonomically.
- **Three front doors, no logic fork** (the cross-cutting "one core, four doors"
  rule). The `search_email` MCP tool gains the new fields as **optional input-schema
  params only** — the tool count and the five tool NAMES are unchanged, so the
  zero-send guard (`agent-surface-zero-send.test.ts`) and the read-only adapter guard
  stay green. The CLI `search` command gains `--cc/--bcc/--any-email/--unread/
  --starred/--since` (still `--json`). A new **read-only** `GET /search` HTTP route
  (API_TOKEN) maps `?from=&to=&cc=&bcc=&any_email=&unread=&starred=&has_attachment=&
  received_after=&received_before=&folder=&thread=&account=&sort=&limit=&offset=`
  onto the same `searchMessages` call. All three are pure reads; none touches
  `src/mcp/` write boundaries, IMAP, or any mutation path.

  > Now guarded (arch #40): the Zod `searchFiltersSchema` and the hand-written
  > `inputSchema.filters.properties` JSON-Schema were kept in sync only by a comment.
  > A `search-schema-parity.test.ts` now asserts the two advertise the SAME field set,
  > so a field added to one but not the other fails the test instead of silently
  > drifting the agent contract. The advertised JSON-Schema is unchanged (its per-field
  > descriptions are editorial), so this is a parity guard, not a derivation.
- **Injection safety is structural, not reviewed.** Recipient/folder/date values keep
  going through the same `Params` binder and `escapeLike()`; a value carrying `'`,
  `%`, `_`, or `;` is escaped and bound, never interpolated. A unit test asserts a
  `drop table … ;--`-shaped value never appears in the compiled SQL text.

## Consequences

- `storeBody` and the soft-delete paths need **zero** code change — a direct result of
  refusing body denormalization.
- The `score` returned by search is ordinal within one query run, not a cross-query
  confidence. The contract documents this.
- On a large existing mirror, the `ADD COLUMN ... GENERATED STORED` rewrite and the GIN
  builds take table-level locks inside the single migration transaction. Fresh / empty
  Empty databases are instant; populated mirrors should pre-build out of band before
  flipping the schema version. Documented in the migration header.
- Tier 2 stays out of the pure core. Any future write capability (send, label) is a
  separate ADR; this surface is read-only (reinforces ADR 0014).

## Verification

- `schema.test.ts` asserts the migration is additive, idempotent, deployment-neutral,
  uses the 128 KB body cap, omits the raw email-array GINs, and self-gates pgvector.
- A live-DB integration test applies `0001..0007` to a real Postgres, proves the
  generated columns populate (including a pathological large body that must not ERROR),
  proves soft-deleted rows and their bodies never appear in results, and asserts the
  flagship ranked query returns the expected order.
- Parser/compiler unit tests prove operator → predicate mapping is deterministic and
  fully parameterized (no string interpolation of user input).
- email-005: `search-parse.test.ts` proves each new structured filter narrows over its
  own column (`to`/`cc`/`bcc` scoped, `anyEmail` across from+to+cc+bcc), composes with
  a semantic free-text query, paginates, and binds an injection-shaped value rather
  than inlining it. `api-safety.test.ts` proves `GET /search` is API_TOKEN-gated,
  composes `q` + filters, accepts filters-only, and 400s on an empty/invalid request.
  The two invariant guards (`agent-surface-zero-send.test.ts`,
  `sync-adapter-read-only.test.ts`) stay green — no sixth tool, no write path.

## Review follow-up (recipient-lane indexes + offset cap)

A whole-stack review found that email-005 added the `to:`/`cc:`/`bcc:`/`anyEmail:`
lanes (`compile.ts`) but `0008_search_layer.sql` only indexed the COMBINED `to||cc`
"recipient" lane. In the no-free-text path there is no 400-row candidate cap, so a
filter-only `bcc:x` / `anyemail:foo` degraded to a full account scan bounded only by
the 15s `statement_timeout` — slow / 500 on a large mailbox.

- `0010_search_recipient_indexes.sql` adds four `gin_trgm_ops` expression indexes whose
  expressions MATCH the `to`/`cc`/`bcc`/`anyEmail` predicates in `filterPredicate`
  EXACTLY (`lower(f_array_to_text(coalesce(<col>,'{}')))`, and the from+to+cc+bcc blob
  for `anyEmail`), each partial on `deleted_in_provider = false` like the 0008
  recipients index. A lane filter is now index-served, not a scan.
- The search `offset` is capped (`SEARCH_QUERY_SCHEMA`, `api.ts`) at 5000: a deep
  OFFSET in the no-candidate-cap structured path scans/scores/discards every prior row.
  Beyond the cap, narrow with filters; keyset pagination remains the longer-term fix.

## References

- ADR 0014: Agent email access is a core read surface.
- ADR 0001: SupaMail core is email sync only (escape hatch invoked by ADR 0014).
- GitHub issues #4 (MCP server) and #7 (agent-first email CLI).
- `apps/api/supabase/migrations/public/0008_search_layer.sql`
- `apps/api/src/search/`
