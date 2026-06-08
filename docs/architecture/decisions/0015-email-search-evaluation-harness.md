# ADR 0015: Email Search Is Eval-Driven, Behind an Engine-Agnostic Harness

Status: Accepted

Date: 2026-06-07

## Context

Search is the flagship read tool for the agent CLI (issue #7) and the MCP server
(issue #4), and the product goal is search that beats provider inboxes for an agent
consumer. "Better than Gmail/Superhuman" is not a property you can assert from code
review — it has to be measured, and measured on *email-specific* behavior, not generic
text retrieval. Email search succeeds or fails on things a generic IR test never
exercises: quoted-reply history polluting relevance, thread collapsing, recency and
folder/newsletter priors, typo and diacritic tolerance, attachment and field operators,
cross-account scope, and paraphrase recall.

There is also a hard product constraint (ADR 0001, AGENTS.md): the public core ships no
*required* AI dependency, and search must work on stock Supabase with zero keys. So we
cannot let the evaluation target be coupled to a paid embedding/LLM stack, and we cannot
let "good search" mean "good vector search."

Finally, no production Postgres search engine has landed on `main` yet. We need a way to
define and lock in *what good email search means* before and independently of any one
engine implementation, so the engine can be driven toward a measurable bar rather than
toward vibes.

## Decision

Email search is developed **eval-first**, behind an **engine-agnostic evaluation
harness** that lives in core at `apps/api/src/search-eval/`.

1. **The evals are the durable contract.** A fixture mailbox plus a golden query set —
   each query tagged with the email-search **capability** it exercises — define the bar.
   Capabilities (not just "text match") are first-class: field/flag/folder/attachment/
   date/size operators, phrase/boolean, fuzzy-typo, unicode-accent, identifier-exact,
   quoted-exclusion, thread-collapse, recency-prior, newsletter-downweight,
   cross-account, and (tracked, not gated) semantic-paraphrase.

2. **Any engine implements one `SearchEngine` interface and is scored identically.** The
   in-repo `ReferenceEngine` is a pure in-process **lexical** engine so the whole suite
   runs anywhere with zero infrastructure and zero keys. A future Postgres/pgvector
   engine (the production target) implements the same interface and is graded by the same
   evals. The reference engine's small synonym map is an explicit stand-in for the
   opt-in Tier-2 vector arm — present only to prove the harness *rewards* semantic recall.

3. **Metrics combine IR scores with email-specific behavioral assertions.** recall@k,
   precision@k, MRR, and nDCG@k, plus pass/fail assertions (`must_not_return`,
   `top_is`, `rank_above`, `thread_collapsed`, `recency_order`, `ordered_prefix`) that
   capture behaviors metrics alone miss — e.g. a term that appears only in quoted reply
   history must not surface the reply.

4. **A measurable GOAL gates CI; the semantic tier is tracked, not gated.** The graded
   (lexical/fuzzy) tier must meet nDCG@10 ≥ 0.80, recall@20 ≥ 0.85, MRR ≥ 0.80, and a
   100% assertion pass rate. The semantic-paraphrase tier is reported but not gated,
   because a pure-lexical baseline is not expected to satisfy it — that is the job of
   the opt-in vector arm. "Improving search toward the evals" means advancing the engine
   configuration (`BASELINE_OPTIONS` → `IMPROVED_OPTIONS` and beyond) until the goal is
   met, then ratcheting.

The harness is read-only and side-effect-free. It introduces **no migration, no schema
change, and no required dependency** (zod is already a core dependency).

## Consequences

- New search behavior is added by first adding/tightening a golden case, then moving the
  engine to satisfy it. Regressions are caught by `pnpm test` (the goal gate) and made
  visible by `pnpm eval:search --compare` (baseline → improved delta).
- The production Postgres engine, when built, is not re-validated by hand: it must clear
  the same bar through the same `SearchEngine` interface. This keeps the CLI and MCP
  surfaces honest against one definition of quality.
- The reference engine is **not** the product search engine and must not be mistaken for
  it. It is a fast, keyless yardstick. Its synonym map is illustrative, not a semantic
  search implementation.
- Because the suite is in-process, it does **not** prove Postgres-specific behavior
  (tsvector ranking, GIN/RUM, pgvector recall). Those require the live-DB lane (ADR 0005)
  once a Postgres engine exists; this ADR does not change that lane.
- Capability coverage gaps are tracked explicitly (e.g. `sender-importance`/VIP priors
  are not yet modeled) rather than silently omitted.

## Verification

- `pnpm typecheck`, `pnpm test` (includes `src/search-eval/search-eval.test.ts`: metric
  unit tests, corpus integrity, the goal gate, and a baseline-vs-improved delta test),
  and `pnpm build` pass.
- `pnpm eval:search` prints the scorecard and exits non-zero if the graded goal is unmet;
  `pnpm eval:search --compare` shows the baseline → improved delta.
- No migration or schema change is introduced, so the live-DB lane (`pnpm test:db:live`)
  is not required for this change.

## References

- ADR 0014: Agent email access is a core read surface (CLI + MCP share one read contract).
- ADR 0001: SupaMail core is email sync only (no required AI dependency).
- ADR 0005: Live Postgres behavior is verified through a Docker-backed reliability gate.
- GitHub issues #4 (MCP server) and #7 (agent email CLI).
- `apps/api/src/search-eval/README.md`.
- Research artifact: `.context/email-search-research.md` (tiered search design; this
  harness operationalizes its Section 6 evaluation plan).
- Note: an ADR numbered 0015 may also exist on the unmerged `search-layer` branch; if
  both reach `main`, the later PR renumbers.
