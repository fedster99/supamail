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
- batch output preserves request order and gives each validated seed its own
  `{message_id, result}` or `{message_id, error}` entry;
- malformed IDs and other batch-shape failures reject the request before any
  item executes;
- selector modes cannot be mixed.

The MCP server instructions and tool definitions describe capabilities,
identifiers, limits, and guarantees without prescribing a reasoning workflow.

## Consequences

The five-tool local MCP surface does not grow. A normal focused read is
unchanged. A broad investigation can expand up to ten conversations per request
with an explicit seed and per-thread message limit.

Thread replies return newly authored text by default. When no older messages
were omitted, the oldest mirrored message keeps quoted content. `read_message`
and `read_thread` return each message's full available cleaned body. This avoids
silently omitting evidence from long messages. A hosted wrapper can still apply
a request-level resource limit to protect the service.

`read_message` also accepts an optional Unicode-safe body range of up to 131,072
characters. The default remains the full cleaned body. The range exists so a
client that truncates an unusually large tool result can recover a specific
missing section without adding another MCP tool.

The agent still owns query refinement, evidence selection, and synthesis.
SupaMail does not add an `investigate_topic`, summary, or reasoning tool.

Remote wrappers that replace database bodies with external body storage must
hydrate all successful batch items under one bounded concurrency limit.

## Verification

- Unit tests cover single-call compatibility, batch ordering, exact-seed
  deduplication, the ten-thread cap, selector exclusivity, request-level batch
  validation, and per-item operational failures.
- MCP instruction tests pin the neutral capability contract.
- Existing live-Postgres `read_thread` coverage continues to prove conversation
  membership, ordering, attachment indexing, message caps, and sync trust.

## References

- ADR 0014: Agent email access is a core read surface.
- ADR 0015: Search is the canonical grouped discovery surface.
- `apps/api/src/mcp/tools/read-thread.ts`
- `apps/api/src/mcp/instructions.ts`
