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

Graded (lexical + fuzzy) tier: **nDCG@10 ≥ 0.80, recall@20 ≥ 0.85, MRR ≥ 0.80, assertions = 100%**.
The **semantic-paraphrase** tier is reported but *not* gated — a pure-lexical engine isn't
expected to satisfy it; that's the job of the opt-in Tier-2 vector arm (see
`.context/email-search-research.md`).

## Email-specific capabilities covered

Field/flag/folder/attachment/filename/date/size operators · phrase · boolean OR/NOT ·
fuzzy-typo · unicode-accent · identifier-exact · **quoted-reply exclusion** ·
**thread-collapse** · **recency-prior** · **newsletter-downweight** · **sender-importance** ·
**Spam/Trash default-exclusion** · cross-account · semantic-paraphrase (tracked).

The suite is intentionally adversarial: quoted-only terms must surface the original not
the reply; signature/footer boilerplate must not drive relevance; near-duplicate
newsletter blasts must not dominate; an unscoped search hides Spam/Trash unless `in:` asks
for it.

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

## Adding an engine (e.g. the production Postgres/pgvector engine)

Implement `SearchEngine` (`index(messages)`, `search(req)`) and pass it to `runEval(...)`.
It is graded by the identical evals — that's how the CLI and MCP surfaces stay honest
against one definition of quality.

## Making the evals better

Add or tighten cases in `golden/cases.json` (and messages in `fixtures/mailbox.json`),
keeping every referenced id real (`corpus.ts` validates this). Prefer cases that a naive
engine fails and an email-aware engine passes — that's where the signal is.
