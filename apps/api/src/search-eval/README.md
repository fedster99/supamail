# Email-search evaluation harness

An **engine-agnostic** harness for measuring *email* search quality — not generic text
search. The evals are the durable contract; the search engine is improved **toward**
them. See ADR 0015.

## Why this exists

"Better than Gmail/Superhuman for an agent" can't be asserted from code review — it has
to be measured, on email-specific behavior. This harness encodes that bar and gates CI on
it, independently of any one engine implementation.

## Run it

```bash
pnpm eval:search            # score the current best engine; non-zero exit if goal unmet
pnpm eval:search -- --compare   # baseline vs improved (before → after delta)
pnpm eval:search -- --json      # machine-readable summary
```

`pnpm test` runs the same suite as a CI gate (`search-eval.test.ts`).

## What's in here

| File | Role |
|---|---|
| `types.ts` | The `SearchEngine` interface + zod-validated `EvalMessage` / `EvalCase` / `SearchRequest`. |
| `fixtures/mailbox.json` | The fixture mailbox — two accounts, threads with quoted history, newsletters, attachments, accents. |
| `golden/cases.json` | Golden queries, each tagged with the email-search **capability** it exercises. |
| `metrics.ts` | recall@k, precision@k, MRR, nDCG@k + email-specific behavioral assertions. |
| `reference-engine.ts` | In-process **lexical** reference engine (`BASELINE_OPTIONS` → `IMPROVED_OPTIONS`). Not the product engine. |
| `runner.ts` | Scores an engine, aggregates per capability, checks the goal. |
| `report.ts` / `cli.ts` | Human scorecard + machine summary. |
| `corpus.ts` | Loads + validates fixtures and checks for dangling references. |

## The goal (CI-gated)

Graded (lexical + fuzzy) tier, gated on BOTH the aggregate and every individual case:

- **Aggregate** (mean over gated cases): nDCG@10 ≥ 0.80, recall@20 ≥ 0.85, MRR ≥ 0.80, assertions = 100%.
- **Per-case floors** (so the mean can't hide one collapsed case): nDCG ≥ 0.70, recall ≥ 0.80, **precision@R ≥ 0.50** (R = #relevant — a scale-free over-retrieval guard).

The **semantic-paraphrase** and **multilingual** tiers are reported but *not* gated — a
pure-lexical engine isn't expected to satisfy them; that's the job of the opt-in Tier-2
vector arm + PGroonga (see `.context/email-search-research.md`).

### The gate has teeth (anti-gaming)

Tests assert that a *firehose* engine (returns everything), a *null* engine (returns
nothing), and the *naive baseline* all **fail** the goal — so passing can't be faked by
returning all/none, and the gate provably discriminates. Determinism is asserted across
runs, and `nonDiscriminatingCases()` fails CI if any gated multi-relevant case lacks an
ordering assertion / graded gains / explicit `order_agnostic` flag (so labels can't be
silently made permutation-invariant).

## Email-specific capabilities covered

Field (from/to/**cc**)/flag/folder/attachment/filename/date/size operators · phrase ·
boolean OR/NOT · **multi-term coverage** · fuzzy-typo · unicode-accent · identifier-exact ·
**quoted-reply exclusion** · **thread-collapse** · **recency-prior** ·
**newsletter-downweight** · **sender-importance** · **from-me / Sent** ·
**Spam/Trash default-exclusion** · cross-account · semantic-paraphrase (tracked) ·
multilingual CJK/RTL (tracked).

The suite is intentionally adversarial: quoted-only terms must surface the original not
the reply; signature/footer boilerplate must not drive relevance; near-duplicate
newsletter blasts must not dominate; an unscoped search hides Spam/Trash unless `in:` asks
for it; `to:` must not match a cc-only recipient; a full multi-term match must outrank a
single high-frequency term.

## Tracked engine gaps (semantic-tier, not gated)

Some cases are deliberately tracked-not-gated and carry a `requires_engine_improvement`
note — they document where the lexical reference engine falls short and the production
engine must do better:

- **VIP / contact-frequency sender-importance prior** — rank a known human correspondent
  above automated/bulk mail even when newsletter down-weight is disabled by a folder scope.
- **from-me / Sent de-prioritization** — an inbound reply should outrank my own newer Sent
  follow-up on the same thread.
- **Language-aware stemming** (e.g. Spanish `vencimiento`↔`vencen`) and **true vector
  recall** beyond the small synonym stand-in.
- **CJK / RTL tokenization** — the `[^a-z0-9]` tokenizer drops non-Latin scripts entirely
  (production uses PGroonga n-gram). `auditCases()` warns on any fixture whose body the
  tokenizer can't split, so these stay confined to tracked cases and never the gate.

## Adding an engine (e.g. the production Postgres/pgvector engine)

Implement `SearchEngine` (`index(messages)`, `search(req)`) and pass it to `runEval(...)`.
It is graded by the identical evals — that's how the CLI and MCP surfaces stay honest
against one definition of quality.

## Making the evals better

Add or tighten cases in `golden/cases.json` (and messages in `fixtures/mailbox.json`),
keeping every referenced id real (`corpus.ts` validates this). Prefer cases that a naive
engine fails and an email-aware engine passes — that's where the signal is.
