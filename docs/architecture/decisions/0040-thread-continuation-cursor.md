# ADR 0040: Thread Continuation Cursor

Status: Accepted

Date: 2026-10-06

## Context

`read_thread` returns the newest `max_messages` messages of a conversation
(default 20, at most 100) and reports the older ones it left out through
`omitted_message_count` and `thread_omissions`. That told an agent that older
messages existed, but gave it no way to read them on the same tool. In
practice (the hosted MCP review of 2026-10-06, a 34-message thread) the agent
read 20 messages, then asked for all 34 and received the first 20 again, or
switched to `search_email` sorted oldest-first and read messages one by one.
Both paths repeat work and text; the second also leaves the thread tool.

Raising or removing the cap was considered. It is simpler code, but a thread
read is already the largest response the tool surface produces, and hosted
wrappers budget it. A separate paging tool, or automatic summaries, would widen
the surface ADR 0030 deliberately kept small.

## Decision

`read_thread` keeps its newest-first page and gains one continuation:

- when older messages remain, the response carries `next_cursor`, the oldest
  returned message's id;
- the same selector (`message_id`, `conversation_id`, or `thread_id`) with
  `cursor` returns the `max_messages` messages before that message, again
  oldest-first within the page;
- the boundary is the cursor message's `(internal_date, id)`, the key the page
  order already uses, so a new reply never shifts an older page and a page
  never repeats a message it already returned;
- `omitted_message_count` counts the messages older than the page, so it
  reaches zero on the last page; `thread.message_count` keeps counting the
  whole conversation;
- the last page has no `next_cursor`; its oldest message keeps quoted content
  and reports `ancestors_not_mirrored`, exactly as an uncapped read does;
- a cursor with nothing before it, or one that names no mirrored message,
  returns `not_found`; a cursor with `message_ids` is `invalid_input`.

The tool description names every accepted input and states that a body range
exists only on `read_message`, because an agent tried `max_body_chars` on
`read_thread` during the same review.

## Consequences

An agent reads a long conversation with one tool and no repeated messages. The
first page is unchanged for existing clients; `next_cursor` is additive. The
query adds one indexed row lookup for the cursor and one count over the
conversation's delivery representatives, which the read already materializes.

When a mirrored copy of an already returned email gains its body between two
pages, the delivery's representative row can change and, with it, that email's
position. This is the existing representative rule, not a cursor rule; the
cursor does not try to hide it.

## Verification

- Unit tests cover the cursor parameter on every selector, the remaining-count
  arithmetic, `next_cursor` presence, the quoted-content rule on the last
  page, the empty page, and the batch and format rejections.
- Live-Postgres tests page through a seeded thread, prove that an older page is
  stable under a new reply, and return `not_found` for a cursor at the start.
- MCP instruction tests pin the description of the continuation and the body
  range note.

## References

- ADR 0030: Bounded batch thread reading.
- `apps/api/src/mcp/tools/read-thread.ts`
- `apps/api/docs/AGENT_EMAIL.md`
