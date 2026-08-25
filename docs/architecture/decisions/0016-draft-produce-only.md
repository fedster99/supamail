# ADR 0016: The Reply Drafter Produces, Never Sends

Status: Accepted

Date: 2026-06-20

## Context

The agent email surface (ADR 0014) is a read-only window onto the Postgres
mirror: search, read a message, read a thread, list folders. The one capability
an agent naturally wants next is to *reply*. ADR 0014 fixed v1 as strictly
read-only — "no send, no mutate, no scheduling" — and made that the hard contract
both the MCP server and the CLI must honor.

But "help me reply" is the highest-value agent action over email, and the mirror
already holds everything needed to compose a correctly-threaded reply: the source
message's `rfc_message_id`, its `references_header`, subject, and the recipient
sets. The tension is between offering that value and not breaching the zero-send
boundary that keeps this surface safe to hand an autonomous agent.

The IMAP write path (send, APPEND, flag/move/delete) lives entirely in the sync
engine and is never imported by the agent surface; `imapflow`, `imap-client`, and
`nodemailer` are out of scope for these tools by construction.

## Decision

`draft_reply` is a **produce-only** tool. It returns a structured, ready-to-send
reply object — `from`, `to[]`, `cc[]`, a single `Re:` subject, RFC 5322 §3.6.4
threading headers (`In-Reply-To`, `References`), and equivalent plain/HTML bodies
— and then stops. The plain body uses interoperable `>` quote prefixes; the HTML
body represents the same history with escaped text and semantic nested
`<blockquote type="cite">` elements.
It does not send, does not IMAP-APPEND a draft, and does not mutate any row.

The boundary is enforced in the schema, not just by convention:

- **No `send` flag exists in the tool's input schema.** There is nothing to set
  to true. An agent cannot ask this tool to deliver mail.
- The tool imports only the read layer and the Postgres mirror. It never imports
  `imapflow`, `./imap-client.js`, or `nodemailer`.
- Threading headers are *derived* from the mirrored source message and returned
  as data; producing them is a pure read + string operation.

Delivery is the caller's job: the user, or the user's mail client, sends the
produced draft. That keeps a human (or an explicitly-authorized downstream
system) in the loop for the one irreversible action.

This preserves ADR 0014's zero-send boundary unchanged. `draft_reply` is the
single tool with `readOnlyHint:false`, and that is *only* because a future option
may let it write a local `.json` draft to disk — never because it touches the
mailbox. Its `destructiveHint` is `false`: producing a draft destroys nothing.

## Consequences

- An agent can compose a correct reply end to end (right recipients, right
  threading, single `Re:`), but the act of sending stays outside this surface.
- Any genuine send/append capability is a **new, separately accepted ADR** — it
  cannot be reached by adding a flag to `draft_reply`, because no such flag
  exists. This mirrors ADR 0014's rule that write capability is always a fresh
  decision.
- The zero-send safety test asserts the absence of a send flag and that no tool
  imports the IMAP write client, so a regression that wires sending in fails CI.
- Remote bindings inherit the boundary by wrapping the same
  `TOOLS` registry and cannot introduce a send path the core does not expose.

## Verification

- `draft_reply`'s `inputSchema` contains no `send` (or equivalent delivery) key,
  and its annotations are `readOnlyHint:false, destructiveHint:false,
  idempotentHint:true, openWorldHint:false`.
- The zero-send safety test (`src/__tests__/agent-surface-zero-send.test.ts`)
  imports `TOOLS`, asserts no tool schema exposes a send flag, and asserts the MCP
  tool modules never import `imapflow` / `imap-client` / `nodemailer`.
- The MCP server's `instructions` and `docs/AGENT_EMAIL.md` both state, as a
  non-goal, that there is no sending or appending.

## References

- ADR 0014: Agent email access is a core read surface (the
  read-only boundary this preserves).
- ADR 0015: Search is a pure-Postgres read layer.
- `apps/api/src/mcp/` (the agent email surface and its tool registry).
- `apps/api/docs/AGENT_EMAIL.md`.
- RFC 5322 §3.6.4 (message threading: In-Reply-To / References).
