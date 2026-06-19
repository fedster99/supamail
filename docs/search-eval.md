# Search Evaluation & Improvement Goal

This is how we measure whether SupaMail search is good, and the concrete goal for
making it **much** better. "Good" is not a vibe here — it is a number, produced by
a reproducible harness, and gated in CI.

> The harness itself is not yet trustworthy enough to drive ship/no-ship — it is
> self-authored, tiny, binary, and has no significance testing or latency axis.
> The goal for fixing *that* is [`search-eval-roadmap.md`](search-eval-roadmap.md).

## The harness

- **Corpus + judged queries:** `apps/api/src/eval/corpus.ts` — a deterministic
  synthetic mailbox (25 messages across invoices, reports, meetings, travel,
  security, project, contracts, recruiting, newsletters, personal, plus a large
  message) and 28 queries, each tagged with a category and the message ids that
  *should* be retrieved (ground truth). Operator queries derive their ground
  truth from the corpus so they stay correct as it grows.
- **Metrics:** `apps/api/src/eval/metrics.ts` — IR metrics (precision@k, recall@k,
  MRR, **nDCG@3/@10 with exponential graded gain `2^g−1`**, success@1/@10),
  unit-tested with no database. **Significance** (`significance.ts`): paired
  permutation test + bootstrap 95% CI, fixed-seed (deterministic).
- **Runner:** `apps/api/src/eval/run.ts` (`evaluateSearch`) seeds the corpus into
  an isolated account against a **frozen clock** (`EVAL_NOW`) with **deterministic
  message UUIDs**, runs every query through the real `searchMessages`, scores it
  with graded judgments, runs the **anti-regression guard** sentinels, and deletes
  the account. Byte-reproducible run-to-run. `compareSearch` A/Bs the recall
  branches against the lexical-only baseline on identical data.
- **CLI:** `pnpm --filter @supamail/api eval:search` spins a disposable Postgres
  (or uses `DATABASE_URL`), applies migrations, and prints a scorecard (human
  summary to stderr, JSON to stdout). `eval:search --compare` prints the A/B
  significance table (Δ, CI, p-value per category).
- **Regression gate:** `apps/api/src/__tests__/search-quality.live-db.test.ts`
  runs in the `Live DB Reliability` CI gate. Beyond the absolute smoke floors it
  now asserts (a) the guard sentinels return nothing, and (b) **no category is
  significantly worse than the lexical baseline** (paired permutation test) — so a
  real move is told from noise rather than read off a small-n mean. Typo/semantic
  stay out of the floor (the goal raises them); the guard is the precision
  backstop.

Run it:

```bash
pnpm --filter @supamail/api eval:search
```

## Baseline (2026-06-07, Tier 0/1 pure-Postgres engine)

**Headline: nDCG@10 = 0.692, Recall@10 = 0.685, MRR = 0.714.**

| Category | queries | nDCG@10 | Recall@10 | notes |
|---|---|---|---|---|
| operator | 8 | **1.00** | **1.00** | `from: is: has: filename: filetype: larger: before:` — provably exact |
| ranking | 3 | **1.00** | **1.00** | recency / weight puts the right hit first |
| phrase | 2 | **1.00** | **1.00** | `"project alpha"`, `"new login"` |
| lexical | 7 | 0.91 | 0.88 | keyword hits in subject/body |
| **typo** | 4 | **0.00** | **0.00** | `invioce`, `secuirty`, `candiate`, `metrcs` — nothing found |
| **semantic** | 4 | **0.00** | **0.00** | `vacation`, `hiring`, `breach`, `expense` — nothing found |

**Diagnosis.** The pure-Postgres engine is excellent where the query words match
(20 of 28 queries average ~0.96 nDCG@10, operators are exact). The entire deficit
is two categories that score a flat **zero**:

- **Typo queries fail** because the free-text path only feeds
  `websearch_to_tsquery` over the FTS columns. The `pg_trgm` indexes that *could*
  catch `invioce`→`invoice` exist, but today they are only used by structured
  operators (`from:`, `subject:`…), never by free text.
- **Semantic queries fail** because there is no embedding tier yet — `vacation`
  cannot match "flight/hotel/booking" by keywords alone. The gated
  `imap_message_embeddings` table exists but is unpopulated and unused.

Both are dragging the headline down by ~27 points, and both are fixable.

## Is this good search, or good *email* search?

Generic IR metrics can be high while the search is still bad at *email*, because
they don't measure what makes email search special: conversations as the unit,
and human mail outranking bulk. So the harness gained an **email-intent** category
(now 32 queries over 31 messages, including a 4-message quoted-reply thread and a
human-vs-newsletter pair) plus a **`distinct_thread_ratio`** metric — distinct
conversations / results in the top 10 (1.0 = no duplicate-thread hits).

It immediately exposed two email-specific failures the generic metrics missed:

- **Conversations weren't grouped.** "budget proposal" returned all 4 quoted
  replies of one thread → `distinct_thread_ratio` 0.25.
- **Bulk wasn't demoted.** "tools" ranked a keyword-rich, recent newsletter above
  a person's actual question (EI2 ranking miss).

**Shipped (this layer):**

- **Thread grouping** (`groupByThread`, default on): the ranker collapses each
  conversation (`coalesce(provider_thread_id, id)`) to its single best message via
  `DISTINCT ON`, and reports `thread.message_count`. Set `groupByThread: false`
  for raw messages.
- **Bulk demotion**: a `list-id` / `list-unsubscribe` (RFC 2369/2919) or bulk-sender
  signal multiplies the email prior down (`-0.7`, clamped), so newsletters sink
  below human correspondence — but stay fully retrievable (`unsubscribe` still
  finds them).

**Result — email-intent category, before → after:** nDCG@10 0.91 → **1.00**,
MRR 0.875 → **1.00**, `distinct_thread_ratio` **0.73 → 1.00**, EI2 ranking miss
fixed. **Zero regression** in operator / ranking / phrase / lexical. Locked in by
the quality gate.

## The goal

> **Raise headline nDCG@10 from 0.69 to ≥ 0.90 and Recall@10 from 0.69 to ≥ 0.90
> by closing the two zero-scoring categories — with zero regression in the four
> categories already at 0.91–1.00.**

**Status: met (2026-06-19).** Phase 1 (trigram fuzzy + concept recall, below)
closed semantic (0.00→0.98) and most of typo (0.00→0.65) with zero regression.
Under the now-graded, frozen-clock eval the headline is **nDCG@10 0.944 /
Recall@10 0.953**, and the A/B significance run (`eval:search --compare`) shows
the recall branches add **+21.2 nDCG@10 points, 95% CI [8.9, 35.4], p=0.004**
over the lexical-only baseline with no category significantly worse. The harness
is still the small synthetic corpus, so even this is a category-level signal, not
a production bar — the trustworthiness upgrades that got us here (graded relevance,
reproducibility, significance, guards) are tracked in
[`search-eval-roadmap.md`](search-eval-roadmap.md). Phase 2 embeddings remain the
durable answer for open-ended semantics beyond the curated thesaurus.

Concrete, independently measurable targets (re-run `eval:search` after each):

| Lever | Metric | From | To |
|---|---|---|---|
| Typo tolerance | typo recall@10 | 0.00 | ≥ 0.75 |
| Semantic recall | semantic recall@10 | 0.00 | ≥ 0.70 |
| Lexical recall | lexical recall@10 | 0.88 | ≥ 0.95 |
| Operators (hold) | operator recall@10 | 1.00 | 1.00 |
| Ranking/phrase (hold) | nDCG@10 | 1.00 | ≥ 0.95 |
| **Overall** | **nDCG@10** | **0.69** | **≥ 0.90** |

## Roadmap

### Phase 0 — Email intelligence (shipped ✓)
Thread grouping + bulk demotion (see the section above). email-intent category to
1.00, `distinct_thread_ratio` to 1.00, no regression. Next email-specific wins:
correspondence weighting (rank people you actually reply to), quoted-reply /
signature stripping before indexing, and sent/needs-reply intent.

### Phase 1 — Tier 1.5: trigram fuzzy + concept recall (shipped ✓)
Two pure-Postgres recall branches added to the **free-text** path
(`apps/api/src/search/expand.ts` + `compile.ts`), both *recall-only*:

- **Fuzzy (typo):** the significant query tokens match via `word_similarity`
  over the trigram-indexed columns (subject / sender / recipients), driving the
  `0007` `gin_trgm_ops` GINs through `OPERATOR(extensions.<%)`.
  `pg_trgm.word_similarity_threshold` is set to `0.4` per-statement via
  `SET LOCAL` in the read-only transaction.
- **Concept (semantic):** a curated, general email/business **concept thesaurus**
  widens the tsquery (`primary || synonyms`), so an intent word retrieves mail
  that never says it literally (`vacation` → travel mail). This is the
  deterministic, zero-dependency stand-in for open-ended semantics; the durable
  general answer is still Phase 2 embeddings.

**Tiering is the safety property:** an `is_primary` flag (any exact lexical hit)
is the leading `ORDER BY` key, so every exact match ranks strictly above every
fuzzy/concept-only match. The recall branches can *add* results a keyword search
misses but can never reorder the ones it already gets right — zero regression by
construction, not by tuning.

**Result (32 queries / 31 messages), before → after:**

| Category | nDCG@10 before | nDCG@10 after |
|---|---|---|
| **Headline** | **0.731** | **0.953** |
| typo | 0.00 | 0.65 |
| semantic | 0.00 | 0.98 |
| lexical | 0.91 | 0.995 |
| operator / ranking / phrase / email-intent | 1.00 | 1.00 (held) |

Residual typo misses are deliberate scope edges: a body-only term (`metrcs`→a
message whose subject lacks "metrics" — body trigram is unindexed, a perf
choice) and a transposition (`invioce`) below the `0.4` threshold whose third
judged doc has no literal token at all. Not chased, to avoid overfitting the
threshold to a 31-doc synthetic corpus.

### Phase 2 — Tier 2: opt-in semantic (gated pgvector)
Stand up the out-of-core embedding job that populates `imap_message_embeddings`
(already in `0007`), add a vector retrieval branch fused via RRF, and measure with
`evaluateSearch({ semantic: true })`. Gated three ways (extension present, table
populated, per-account flag); absent it, search is unchanged.
- Expected: semantic 0.00 → ~0.70–0.80; headline ≥ 0.90.

### Phase 3 — Ranking & corpus depth
- Soften multi-term free text from strict AND to "AND-preferred, OR-fallback" so
  `candidate interview` also surfaces strong single-term hits (the L7 miss).
- Add email-signal ranking polish (sender importance / correspondence weighting)
  and grade the judgments (3/2/1) for sharper nDCG.
- Grow the corpus toward real anonymized mail; add per-query latency to the
  scorecard and a latency budget to the gate; track the headline over time.

Every phase is shippable on its own and verified by the same harness, so progress
is always a number, not a claim.
