# Agent Email Guide

SupaMail exposes your mirrored mailbox to an agent as a small, **read-only** MCP
surface over the Postgres mirror, plus one reply **drafter**. This is the
long-form of the server's `instructions` string (ADR 0014, ADR 0015, ADR 0016).

Five tools. **Zero send.** Nothing here ever sends, appends, moves, deletes, or
mutates mail — the only optional write any tool performs is producing a draft
object you hand back to the user.

## Connect an MCP client

Install dependencies and build the server:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Then add a stdio server to your MCP client's configuration, replacing the
repository and database placeholders:

```json
{
  "mcpServers": {
    "supamail": {
      "command": "node",
      "args": ["/absolute/path/to/supamail/apps/api/dist/mcp/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://user:password@host:5432/database",
        "IMAP_ENCRYPTION_KEY": "the-same-key-used-by-your-worker"
      }
    }
  }
}
```

The process communicates only over stdin/stdout. It does not open a remote
listener; remote deployments provide their own transport and authentication.

## The five tools

| Tool | Purpose | Key params |
| --- | --- | --- |
| `search_email` | Canonical ranked search over the mirror. | `q` (free-text + operators), `filters`, `accounts`, `sort`, `limit` |
| `read_thread` | One durable conversation or a batch of up to ten. Exact duplicate seeds are collapsed; each valid distinct seed has its own result or error entry. | `message_id` (seed) \| `message_ids` (1–10 seeds) \| `conversation_id` + `account` \| legacy `thread_id` + `account`; `include_quoted=false`, `max_messages=20` per thread (max 100) |
| `read_message` | One message with its full available cleaned body, cc, and attachments. | `message_id`, `include_headers=false`, `include_quoted=false`, optional `body_offset`, optional positive `max_body_chars` |
| `list_folders` | Folders + unread/flagged/total counts for an account. | `account?` |
| `draft_reply` | Produce (never send) a ready-to-send reply. | `source_message_id`, `body`, `reply_all=false` |

## The ID model

A search hit looks like `{ identity: { id, account_id, folder_path, ... }, ... }`.
The stable handle is **`identity.id`** — it equals `imap_messages.id`.

- `read_message {message_id}` accepts `identity.id` and returns that single message.
- `read_thread {message_id}` accepts `identity.id` and returns the conversation
  that message belongs to. A stored assignment resolves the complete, transitive
  account-scoped conversation and returns one representative for each delivered
  email, not one result for every mirrored folder copy.
- `read_thread {message_ids:[...]}` accepts one to ten message IDs. Exact
  duplicates are removed in first-occurrence order. After the request passes
  batch validation, each distinct seed returns its own result or error, so one
  operational failure does not discard the other results.
- `read_thread` returns `thread.conversation_id`, SupaMail's durable conversation
  handle, plus `thread.provider_thread_id` as provider metadata when available.
  A direct `conversation_id` lookup always requires `account` because conversation
  identifiers are account-scoped. Direct legacy `thread_id` lookup also requires
  `account` because provider IDs are not globally unique.
- `draft_reply {source_message_id}` accepts the same `identity.id`.

Message IDs are returned by `search_email`, `read_message`, and `read_thread`.

`read_message` and `read_thread` return the full available cleaned body for each
message. Replies return newly authored text by default. They
remove recognized quoted reply tails and signatures. When no older messages
were omitted, the oldest mirrored message keeps quoted content.
`include_quoted=true` keeps quoted content in all messages.
`read_message` can return a specific range when `body_offset` or
`max_body_chars` is supplied. There is no product character ceiling.
`body_total_chars`, `body_next_offset`, and `body_truncated` describe the range.
Every message also returns `body_content_status` and `body_omissions`. A
`partial` status explicitly identifies source text that sync stored only in part
(`source_truncated`), quoted text, a signature, or text outside the requested
range that is not present in `body`. `body_truncated` describes only a requested
response range; it does not hide source truncation.

Every thread returns `thread_content_status`, `thread_omissions`, and
`omitted_message_count`. A `partial` status explicitly identifies older messages
removed by `max_messages`.

Search groups by durable conversation by default and first deduplicates physical
copies of one delivery. A hit's `thread.conversation_id` is therefore the right
handle for expansion; `thread.message_count` counts distinct delivered emails,
not folders containing the same email.

Conversation membership is protocol-derived: valid RFC `References` /
`In-Reply-To`, unresolved parent IDs, then account-scoped provider thread hints.
The final subject/participant fallback is deliberately conservative and runs
only over one complete, bounded exact-subject bucket; oversized common subjects
are skipped. Body similarity and cross-conversation task/document clustering are
not part of this layer. A message still awaiting its durable assignment
temporarily uses the legacy one-hop read fallback.

## Non-goals

These capabilities are not exposed in v1:

- **No sending or appending.** There is no send tool, no send flag, and
  `draft_reply` only produces a draft object (ADR 0016). Its quote includes the
  full available source body; it does not silently apply a quote-size cap.
  The draft includes equivalent plain and HTML bodies: plain-text quotes use `>`
  prefixes, while HTML uses semantic nested `<blockquote type="cite">` elements.
  The readable attribution date is labeled `UTC` because the server has no
  user-time-zone setting.
- **No attachment bytes or content extraction.** Only attachment *metadata*
  (filename, mime type, size, disposition) is mirrored; the bytes are not.
- **No mutations.** No labels, flags, moves, deletes, marking read, or scheduling.

## What `sync_trust` means

Every successful read result attaches a `sync_trust` block describing how
complete the mirror is for the accounts you touched. In a batch thread response,
each successful entry carries its own block inside `result`; error entries do not.
The mirror fills incrementally (initial sync, then history backfill, then bodies),
so a result set can be a partial view.

`sync_trust` reports, per account: `sync_state`, whether initial sync or a
historical backfill is in progress, and live/historical completeness percentages.
The top-level `fully_synced` is true only when every searched account is HEALTHY,
not initial-syncing, not backfilling, and at 100% live coverage;
`results_may_be_incomplete` and `degraded_reasons` spell out why when it is not.

`results_may_be_incomplete=true` means the returned mirror view may be partial.

## Errors

Request-level errors are returned as `{ error: { code, message, hint } }`;
`hint` contains recovery information. An invalid batch shape or malformed UUID
fails at this level before any item runs. Valid batch thread reads return
`{ threads: [{ message_id, result } | { message_id, error }] }`, with the same
error fields inside the affected thread entry. **Empty results are not errors** —
an empty list means the query ran and matched nothing.
