# ADR 0030: Bounded Batch Thread Reading

Status: Accepted

Date: 2026-08-01

## Product Principle

Build the smallest intent-oriented tool surface that lets an agent complete
common goals quickly. Reduce round trips through batching, useful responses,
and sensible defaults—not by adding a specialized tool for every workflow.

Optimize total agent effort, not tool count or request count independently.
Combine operations when they share one intent, permission, target-selection
model, and result shape. Keep them separate when combining them would create a
branching catch-all tool.

## Context

A broad email investigation starts with grouped search results, then expands
the relevant conversations as evidence. `search_email` already groups by
conversation and returns ranked snippets and stable message handles.
`read_thread` previously accepted only one conversation seed, so examining many
search candidates multiplied otherwise acceptable per-request latency into a
long serial workflow.

Adding a separate `read_many_threads` or workflow-specific investigation tool
would save requests by expanding the tool surface. Returning every full thread
from search would instead make ordinary searches unnecessarily large and blur
discovery with evidence reading.

## Decision

Keep the existing `read_thread` tool and add a `message_ids` batch selector:

- one `message_id`, `conversation_id`, or provider `thread_id` keeps the existing
  single-thread input and response;
- `message_ids` accepts one to ten message handles;
- exact duplicate handles are removed while preserving first-seen order;
- at most four threads execute concurrently;
- shared `include_quoted` and `max_messages` controls apply to every thread;
- batch output preserves request order and returns `{message_id, result}` or
  `{message_id, error}` independently for each seed;
- selector modes cannot be mixed.

The MCP server instructions and tool definitions describe capabilities,
identifiers, limits, and guarantees without prescribing a reasoning workflow.

## Consequences

The five-tool local MCP surface does not grow. A normal focused read is
unchanged. A broad investigation can expand up to ten conversations per request
without making one oversized, unbounded response.

The agent still owns query refinement, evidence selection, and synthesis.
SupaMail does not add an `investigate_topic`, summary, or reasoning tool.

Remote wrappers that replace database bodies with external body storage must
hydrate all successful batch items under one bounded concurrency limit.

## Verification

- Unit tests cover single-call compatibility, batch ordering, exact-seed
  deduplication, the ten-thread cap, selector exclusivity, and independent
  validation and operational failures.
- MCP instruction tests pin the neutral capability contract and the advertised
  schema bound.
- Existing live-Postgres `read_thread` coverage continues to prove conversation
  membership, ordering, attachment indexing, message caps, and sync trust.

## References

- ADR 0014: Agent email access is a core read surface.
- ADR 0015: Search is the canonical grouped discovery surface.
- `apps/api/src/mcp/tools/read-thread.ts`
- `apps/api/src/mcp/instructions.ts`
