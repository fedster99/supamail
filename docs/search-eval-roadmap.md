# GOAL: Make the SupaMail Search Eval Trustworthy Enough to Drive Ship/No-Ship

This is the goal for the *eval and harness* — improving how we **measure** search,
not the search itself. It is grounded in an adversarial audit of the current
harness (`apps/api/src/eval/`, `scripts/eval-search.ts`,
`src/__tests__/search-quality.live-db.test.ts`) that cited real lines in our own
code. Companion doc: [`search-eval.md`](search-eval.md) (the harness + the search
quality goal).

## 1. Thesis

A trustworthy eval is one whose numbers a reasonable engineer would bet a release
on: it measures *search quality* (not "which features are built"), it is
*reproducible* run-to-run, it can tell *signal from noise* on the 1–2 point moves
at which we actually make ship/no-ship calls, and its ground truth is *independent
of the author of the engine*. Today's harness fails all four, and the deepest
failure is a single compounding trio.

- **(a) Circularity.** The same person authored the 31-message corpus, the
  relevance judgments, AND `searchMessages` — so the headline is a self-consistency
  check, not a capability test. The operator category (`ndcg===1`) is a near-
  tautology because both the engine and the "ground truth" compute membership from
  the same predicate.
- **(b) Tiny synthetic corpus.** 31 hand-authored docs vs real mailboxes of
  10k–500k means recall@10 / success@10 / nDCG@10 are saturated near 1.0 (judged
  sets of 1–7 always fit inside the top 10), no latency/p95 is measured at all
  (`timing_ms.total` is computed in `search.ts` and discarded in `run.ts`), and
  whole classes of real bugs — HTML/quoted-reply noise, multilingual mis-stemming,
  identity disambiguation, power-law senders — are untestable by construction.
- **(c) No significance.** At n=32 (2–7 per category) with a plain mean and hard
  floors, a 1–2 point nDCG move is pure noise — yet the scorecard prints to 0.1%
  and the gate asserts absolute thresholds.

On top of the trio, **the headline ~0.73 is structurally misleading**: 8 of 32
queries (typo T1–T4, semantic S1–S4) test capabilities the engine *cannot
implement by construction* (no trigram-fuzzy/vector code exists; the `semantic`
flag is a documented no-op), so they score a tautological 0.0. That means ~0.73
encodes "these features aren't built," not "search is 73% good," and it will
spuriously "improve" the moment any fuzzy fallback ships — with zero anti-
regression guard on the 24 passing queries. And because recency uses `now()`,
scores aren't even reproducible: the recorded baseline comment (`0.692`) already
disagrees with the stated headline (`~0.73`), proving small-n drift is being
treated as a stable number.

## 2. What the current harness can't yet tell us (real failures it would MISS)

- **Right doc, wrong rank.** `run.ts` forces every relevant doc to grade 1, so
  nDCG's ideal is "all relevant docs in any order" — blind to ordering *among*
  relevant docs, the #1 real-world complaint.
- **A latency/scale regression.** A plan that seq-scans or does an O(n) trigram
  scan passes every quality gate while being unshippable at 100k docs.
  `timing_ms.total` is computed and thrown away. No p50/p95/p99, no scale corpus.
- **Over-matching when fuzzy ships.** A naive trigram fallback returning 20 junk
  docs for `invioce` looks like *pure improvement* (0.0 → something) with no
  precision guard on the 24 already-passing queries. We'd celebrate a regression.
- **Finding *more* relevant mail than the author tagged.** Untagged ids count as
  non-relevant, so a ranker that legitimately surfaces inv-4 ("Quarterly billing
  summary") for `payment` *lowers* precision — the eval discourages correct
  behavior. The judgments are also internally inconsistent (inv-4 is relevant to
  `invoice` with no "invoice" token, but the budget thread isn't tagged for
  `expense` though a budget is an expense).
- **The wrong Sarah.** Exactly one Sarah, one Bob — no name collision, no person
  with two addresses. EI3 `sarah` *cannot fail* on disambiguation; an agent
  drafting a reply to the wrong Sarah gets full credit.
- **A thread-merge bug.** Only one multi-message thread exists and no two distinct
  threads share a subject, so a "Re: meeting" collapse-bug is unreproducible.
  `distinct_thread_ratio` is ~1.0 by construction and **defaults to 1.0 on empty
  results** — masking the typo/semantic total-miss as a *perfect* thread score.
- **HTML / signature / quoted-reply noise.** Bodies are hand-clean plain text;
  no "Sent from my iPhone" footer, no long quoted history. We can't tell whether
  footer terms cause false positives or quoted repetition inflates ranking.
- **Multilingual mis-stemming.** 100% English corpus + `to_tsvector('english')`
  means a French `facture` / German `Rechnung` failure scores 1.0 by construction.
- **The agent-facing payload.** `run.ts` collapses the rich `SearchResponse` to a
  list of ids, discarding snippets (the agent's answerability surface), parser
  warnings, thread counts, and the zero-result signal. A change that empties every
  snippet moves no metric.
- **The product's stated honesty differentiator.** `sync_trust` is computed on
  every search and never asserted. A regression that always returns
  `fully_synced=true` mid-backfill (telling the user "you have no invoice from
  Acme" when bodies are 40% synced) passes every gate.
- **Regression vs noise.** No per-query variance, no bootstrap. One lexical query
  dropping 1.0→0.0 moves the category mean 0.14; phrase (n=2) and ranking (n=3)
  flip below their 0.95 floor on a single `now()`-tie. A ~13% headline regression
  still passes the 0.6 floor silently.
- **Slow drift across commits.** No persistence; the only "baseline" is a stale
  hand-typed comment. Death by a thousand 0.5-point cuts is invisible.

## 3. The goal as measurable targets

| Lever | Today | Target | How we'd measure |
|---|---|---|---|
| **Graded relevance** | Binary; grade forced to 1 | 0–3 grades, exponential gain `2^g−1` | Permuting two relevant docs of different grade moves nDCG@10 (today it doesn't) |
| **Built vs unbuilt** | Headline includes 8 tautological 0.0 queries | Headline over the 24 *built* queries; typo/semantic as a separate "capability-gap" line | Two numbers; post-fuzzy, precision@5 on the 24 must not drop |
| **Reproducibility** | `now()`-based recency; scores drift | Frozen `EVAL_NOW`; byte-identical scorecards | Two runs → identical ordered id lists + scores |
| **Query count / power** | 32; no significance | ≥100 queries; MDE on nDCG@10 ≤ 0.02 at 80% power | Per-category n + bootstrap 95% CI; CI width tracked |
| **A/B + significance** | Single system vs constants | Same-run baseline-vs-candidate; paired permutation test + bootstrap CI | `--baseline <ref>` prints per-category delta + p-value |
| **Independent judgments** | Self-authored | Second judge (human or calibrated LLM) on a sample | Cohen's κ ≥ 0.6; count new relevant docs the 2nd judge finds |
| **Incomplete-judgment robustness** | Recall ÷ hand-listed set | Pooling + bpref + condensed-list nDCG + judged@k | judged@10 ≥ 0.8 to trust a score |
| **Latency p95** | Discarded | p50/p95/p99 per query + corpus-wide; gated | Latency block; gate p95 (A/B not significantly above baseline) |
| **Scale realism** | 31 docs | Generated 10k–100k mailbox (power-law senders, HTML+quoted bodies, overlapping threads, locales) | p95 at scale gated; planted subject-collision drops `distinct_thread_ratio` < 1.0 |
| **Agent-payload correctness** | Only id list scored | success@1, snippet_present_rate, snippet_answerability, warning correctness, zero_result_rate | top1_snippet_answerability ≥ 0.8; snippet_present_rate ≥ 0.95 |
| **sync_trust honesty** | Computed, never asserted | 5 seeded scenarios assert the block exactly | sync_trust_accuracy = 5/5; false_reassurance_rate = 0 |
| **Trend history** | None; stale comment | Checked-in JSONL ledger keyed by SHA + corpus_hash + metric_config | Queryable nDCG/p95 time series; injected regression visible |
| **Corpus as data** | TS literal | JSONL data files + a generator; operators derived | Corpus grows to thousands without TS edits |
| **Real-vs-synthetic** | 100% synthetic, self-authored | Dev/held-out split; independent-phrasing query pool | Report dev vs held-out; flag overfit when dev−test > 0.05 |

## 4. Phased roadmap

Ordered by **credibility impact ÷ effort**. Each phase is independently shippable
and self-verifying. Phases 0–2 are pure-deterministic and need no new infra.

> **Status (2026-06-19): Phases 0–2 shipped.** The eval is now reproducible
> (frozen `EVAL_NOW` + deterministic message UUIDs → byte-identical scorecards),
> graded (exponential-gain nDCG with a 0–3 rubric), guarded (junk-return
> sentinels), and **significance-gated** (paired permutation test + bootstrap 95%
> CI; `pnpm eval:search --compare`). The CI gate now asserts "no category
> significantly worse than the lexical baseline" rather than an absolute floor.
> Phases 3–6 (latency-at-scale, agent-payload, `sync_trust` assertions, trend
> ledger, LLM judge, 10k–100k corpus) remain open.

### Phase 0 — Stop lying about the headline (hours; do immediately)
- **Freeze the clock.** Introduce an `EVAL_NOW` constant; seed `internal_date`
  relative to it and compute recency against the same frozen instant instead of
  `now()`. The harness becomes bit-reproducible and ties become deterministic.
- **Split the headline.** Report nDCG@10 over the 24 *built-capability* queries as
  the headline; report typo/semantic as a separate "capability-gap: 0/8" line. Add
  nDCG@3 / nDCG@5 so ranking is actually exercised on a 31-doc index.
- **Fix the two masking bugs:** `distinct_thread_ratio` records `null`/excluded on
  empty results (not 1.0); drop saturated `success@10` from the headline and add
  per-metric saturation flags (share of queries ≥0.95).
- **Verify:** two consecutive `pnpm eval:search` runs produce byte-identical JSON.

### Phase 1 — Graded relevance + anti-regression guard (1–2 days)
- Change `EvalQuery.relevant` from `string[]` to a graded map `Record<id, 0|1|2|3>`;
  stop forcing grade 1; use exponential gain `2^g−1` in `dcgAtK`. Re-grade the 24
  queries (e.g. `payment` → inv-3 receipt=3, inv-1/inv-2=2, inv-4 billing-summary=1),
  recording borderline docs as grade-1 so finding them neither helps nor hard-hurts —
  resolving the internal-inconsistency complaints.
- Add a **guard set**: hard typo/semantic cases whose *correct* answer is to return
  nothing or a precise small set, so a junk-returning fuzzy fallback shows as a
  precision drop, not improvement.
- **Verify:** a planted mis-order moves ranking/lexical nDCG below 1.0.

### Phase 2 — Significance + A/B as the primary mode (2–3 days)
- Add `compare(baseline, candidate)`: run both against the *same seeded corpus in
  the same run* (same `EVAL_NOW`, so recency drift cancels), pair per-query
  nDCG/MRR vectors, run a paired permutation test (10k sign-flips, fixed seed →
  deterministic) + bootstrap 95% CI.
- `pnpm eval:search --baseline <ref>` prints a per-category delta table with
  significance. **Convert the gate** from "headline ≥ 0.6" to "no category
  significantly worse than baseline (p<0.05) and headline delta CI-lower > −ε,"
  keeping a low absolute smoke floor as backstop. Label categories with n<5
  (phrase=2, ranking=3) as "directional only."

### Phase 3 — Latency + agent payload + sync_trust (2–3 days)
- **Latency:** capture `timing_ms.total` per query, run 5–10 warm iterations,
  record p50/p95/p99, print a LATENCY block, gate p95 (relative until scale lands).
- **Agent payload:** retain the full `SearchResult`; add success@1 / precision@1,
  `snippet_present_rate`, `snippet_answerability` (tag fact-bearing queries with an
  `answer_substring` like `$1,250`, `UA123`, `March 31`), `warning_correctness`,
  `zero_result_rate`.
- **sync_trust:** parameterize seeding to set sync_state / backfill / progress, then
  assert the returned block across 5 scenarios. Gate `sync_trust_accuracy = 5/5`,
  `false_reassurance_rate = 0`. **Highest-leverage email-specific fix** — it's the
  product's stated differentiator and is currently untested.

### Phase 4 — Trend persistence + corpus as data (2–4 days)
- Persist each run's scorecard as a checked-in JSONL ledger keyed by `SHA +
  corpus_hash + metric_config + judge/prompt version`; the A/B gate compares
  against the *stored* previous run, not a constant; a corpus change is stamped a
  discontinuity, not a regression.
- Move the corpus out of the TS literal into JSONL + a loader. Add a corpus-
  invariant test: **no two ids in any free-text relevant set share a
  `provider_thread_id`** (guards the latent thread-grouping trap as the corpus
  grows). Add ≥2 distinct threads sharing a subject so `distinct_thread_ratio` is
  falsifiable.

### Phase 5 — Break circularity: independent + LLM judge (3–5 days)
- Add an LLM-judge labeling path (pointwise 0–3 rubric, temperature 0, prompt
  version stored with qrels) over the *pooled* candidate docs from all variants.
- **Keep the LLM judge OUT of the gate until calibrated.** Use the 32 hand
  judgments as a calibration set; report Cohen's κ / Kendall τ; admit LLM qrels to
  A/B only when κ ≥ 0.6 and τ ≥ 0.8. Track how many *new* relevant docs the judge
  surfaces — that count *is* the conflict-of-interest blind spot.
- Add pooling + bpref + condensed-list nDCG + judged@k so recall stops penalizing a
  better system for finding untagged-but-relevant docs.

### Phase 6 — Scale + email-realism corpus (1–2 weeks; biggest realism payoff)
- Generate a 10k–100k-doc mailbox: power-law senders, ~50–60% bulk/transactional
  vs human, varied-depth threads, attachment-heavy senders, recent-heavy dates,
  multiple locales, HTML+quoted+signature bodies. Run it as a **separate non-gating
  quality report with CIs**, gating only p95 latency initially.
- Add the missing email-specific categories on this corpus: identity disambiguation
  (two Sarahs; sender-match must outrank body-mention; `wrong_person_rate` → 0),
  recency-intent (`latest invoice` → newest, success@1), in-content date, direction
  intent (Sent + `\Answered`: "threads waiting on my reply"), expanded human-vs-bulk
  (≥6 pairs), multilingual, and messy/half-remembered queries generated by an LLM
  from intent descriptions *never shown the doc tokens* (to break author-vocabulary
  bias). Keep the 31-doc hand set as the fast deterministic unit gate.

## 5. The circularity problem — what we actually do

One person wrote the corpus, the judgments, and the engine, so our numbers can only
confirm what we already believe. Three layered defenses, none requiring real user
logs:

1. **Independent second judgment (Phase 5).** A second human and/or calibrated LLM
   re-grades a blind sample; report Cohen's κ (we don't trust κ < 0.6) and count
   **how many relevant docs the second judge finds that the author missed** — that
   number quantifies the blind spot. Until then, document the relevance rubric in
   the corpus header so "why is inv-4 relevant to `invoice` but news-tools not
   relevant to `tools`" is answerable rather than fiat.
2. **Independent query phrasing (Phase 6).** The author chose query strings
   *because they match* (the S-series notes literally say "no X token in the mail").
   Break the loop by generating realistic phrasings from a one-line intent with an
   LLM that **never sees the doc text**, and import anonymized real queries when
   available. Report the headline split "authored" vs "independent-phrasing" — a
   large gap *is* the overfitting signal.
3. **Held-out test partition + pooling (Phases 5–6).** Split queries into DEV (tuned
   against) and a HELD-OUT TEST partition that only runs pre-merge; flag overfit when
   dev−test > 0.05. Pool top-k from *every* variant before judging. Make operator
   tests adversarial (plant `billing@acme.co` vs `.com`, a `.pdf` mentioned in body
   text but not as an attachment) so the operator category can actually be *wrong* —
   today `ndcg===1` because both sides read the same predicate.

**The hard line:** no 1–2 point nDCG claim drives a ship decision until (a) the
clock is frozen, (b) significance testing is in place at n≥~50, and (c) at least
the independent-phrasing or second-judge defense has reported κ. Until then the
eval is a smoke test, and we call it one.

## 6. Risks of over-investing — staying pragmatic

- **Building a TREC clone nobody runs.** Keep it fast and one-command; the 31-doc
  deterministic set stays the quick CI gate. Scale corpus, LLM judge, and pooling
  run as separate (possibly nightly) reports. If a phase makes the pre-merge gate
  slower than ~60s, it belongs in the slow lane.
- **LLM-judge theater.** An uncalibrated LLM judge is *more* dangerous than self-
  judgment because it looks objective. Gate admission on κ ≥ 0.6 vs humans, store
  the prompt hash, keep it out of the ship gate until calibrated.
- **Reproducibility into rigidity.** Freezing the clock is essential, but persist
  `corpus_hash`/`metric_config` so a deliberate change is a *discontinuity flag*,
  not a red build; re-baseline on merge.
- **Synthetic realism is asymptotic.** A generated 100k mailbox is still not real.
  Treat scale results as *relative* (candidate vs baseline on identical data) and a
  no-regression tracker, not an absolute production number. Face-validity is an
  opt-in throwaway-account real-mail mode, not the corpus of record.
- **Premature query-set inflation.** 100 self-authored tidy queries are worth less
  than 40 independently-phrased ones. Prioritize independence and grading over raw
  count; the MDE target (≤0.02 at 80% power) is the stopping criterion.
- **Don't let the eval block the features it scored 0.0 for.** Keep typo/semantic
  *out* of the regression floor (the gate already does) so shipping fuzzy/semantic
  is never blocked; the guard is the precision anti-regression check on the 24 built
  queries, not a higher typo/semantic floor.

## 7. Implementation map

- `apps/api/src/eval/corpus.ts` — graded map + provenance/rubric header + JSONL migration
- `apps/api/src/eval/metrics.ts` — exponential gain, bpref, condensed nDCG, judged@k, success@1, significance helpers
- `apps/api/src/eval/run.ts` — frozen clock, stop forcing grade 1, capture `timing_ms` + `sync_trust` + full `SearchResult`, pooling, A/B `compare()`
- `apps/api/scripts/eval-search.ts` — latency + agent + sync_trust blocks, `--baseline` mode, persisted JSONL ledger
- `apps/api/src/__tests__/search-quality.live-db.test.ts` — significance-based regression gate replacing the absolute 0.6 floor and the hand-typed baseline comment

**Order of attack:** Phase 0 first — it fixes live bugs (the `distinct_thread_ratio`
empty-result mask, the misleading headline, non-reproducibility) in hours and makes
every later number honest.
