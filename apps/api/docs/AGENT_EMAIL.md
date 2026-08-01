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

## The loop: orient → search → read → draft

1. **Orient** — `list_folders` shows the folders that **contain mail** for an
   account with per-folder `total` / `unread` counts and account-level `total` /
   `unread` / `flagged` totals (a folder with no mirrored messages is not listed).
   One call to answer "where am I, what needs attention".
2. **Search** — `search_email` is the canonical ranked search. Every hit carries
   a mailbox `identity` whose `id` is the stable message handle.
3. **Read** — `read_message` (one message, full body) or `read_thread` (the whole
   conversation) — pass a search hit's `identity.id` as `message_id`.
4. **Draft** — `draft_reply` produces a ready-to-send reply with correct
   threading headers. It never sends; you (or the user's client) send it.

## The five tools

| Tool | Purpose | Key params |
| --- | --- | --- |
| `search_email` | Canonical ranked search over the mirror. | `q` (free-text + operators), `filters`, `accounts`, `sort`, `limit` |
| `read_thread` | The whole durable conversation, seeded from one message or selected directly. | `message_id` (seed) \| `conversation_id` + `account` \| legacy `thread_id` + `account`; `include_quoted=false`, `max_messages=20` |
| `read_message` | One message with full body, cc, attachments. | `message_id`, `include_headers=false`, `include_quoted=false` |
| `list_folders` | Folders + unread/flagged/total counts for an account. | `account?` |
| `draft_reply` | Produce (never send) a ready-to-send reply. | `source_message_id`, `body`, `reply_all=false` |

## The ID model

A search hit looks like `{ identity: { id, account_id, folder_path, ... }, ... }`.
The stable handle is **`identity.id`** — it equals `imap_messages.id`.

- Pass `identity.id` as `read_message {message_id}` to read that single message.
- Pass `identity.id` as `read_thread {message_id}` to read the conversation that
  message belongs to. A stored assignment resolves the complete, transitive
  account-scoped conversation and returns one representative for each delivered
  email, not one result for every mirrored folder copy.
- `read_thread` returns `thread.conversation_id`, SupaMail's durable conversation
  handle, plus `thread.provider_thread_id` as provider metadata when available.
  A direct `conversation_id` lookup always requires `account` because conversation
  identifiers are account-scoped. Direct legacy `thread_id` lookup also requires
  `account` because provider IDs are not globally unique.
- `draft_reply {source_message_id}` takes the same `identity.id`.

You never construct ids yourself — always copy one back from a search hit (or
from a `read_thread` message).

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

## Recipes

- **Latest email from someone:** `search_email {q:"from:alice@example.com sort:recent", limit:1}`.
- **Unread today:** `search_email {q:"is:unread newer_than:1d", sort:"recent"}`.
- **Triage the inbox:** `search_email {q:"is:unread", sort:"recent"}`, then
  `read_message` the ones that matter.

## Non-goals

These are deliberate and permanent for v1 — do not attempt them:

- **No sending or appending.** There is no send tool, no send flag, and
  `draft_reply` only produces a draft object (ADR 0016).
- **No attachment bytes or content extraction.** Only attachment *metadata*
  (filename, mime type, size, disposition) is mirrored; the bytes are not.
- **No mutations.** No labels, flags, moves, deletes, marking read, or scheduling.

## What `sync_trust` means

Every read tool attaches a `sync_trust` block describing how complete the mirror
is for the accounts you touched. The mirror fills incrementally (initial sync,
then history backfill, then bodies), so a result set can be a partial view.

`sync_trust` reports, per account: `sync_state`, whether initial sync or a
historical backfill is in progress, and live/historical completeness percentages.
The top-level `fully_synced` is true only when every searched account is HEALTHY,
not initial-syncing, not backfilling, and at 100% live coverage;
`results_may_be_incomplete` and `degraded_reasons` spell out why when it is not.

If `sync_trust` says results may be incomplete, **say so** — do not present a
partial mirror as the whole mailbox.

## Errors

Errors are returned as `{ error: { code, message, hint } }`. The `hint` tells you
what to do next. **Empty results are not errors** — an empty list means the query
ran and matched nothing.
