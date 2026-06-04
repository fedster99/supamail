# ADR 0014: Agent Email Access Is a Core Read Surface, Hosted in Cloud

Status: Accepted

Date: 2026-06-04

## Context

Issue #4 (MCP server for AI email tools) and issue #7 (agent-first email CLI) both let an agent read mirrored email. The maintainer considers agent-access-to-email a first-class product pillar, not an optional add-on: the value of the mirror is multiplied when an agent can query it through a stable, machine-readable contract.

Two earlier decisions appear to push these out of the public core:

- ADR 0001 says the core does not own MCP or AI workflows "unless a future issue explicitly adds a separate package/process" behind "a separately accepted ADR."
- ADR 0007 assigns "remote MCP auth" to the private hosted repo.

Read together, the open question was whether the MCP server and agent CLI should be built in this repo at all, or moved to `supamail-cloud`. The resolution turns on a distinction the rest of the product already uses: where code is built is not where it runs. The Docker image, the `SUPAMAIL_MODE` runtime, and the `target-scheduler` contract are all built in core and merely run by cloud.

## Decision

Agent email access is a first-class core capability, delivered as a separate read-only surface. This invokes the explicit-issue escape hatch in ADR 0001; issues #4 and #7 are the anticipated future issues, and this ADR is the separately accepted exception. #4 and #7 stay in this repo and are not moved to `supamail-cloud`.

Build location is not run location. The seam between core and cloud is transport and auth, not tool logic.

Core owns the artifact and the contract:

- the MCP server implementation and its read-tool schema (which tools exist, what they return)
- the agent CLI commands and their deterministic, machine-readable output, including sync-trust signals
- the local stdio transport binding, usable by any self-hoster against their own database
- the read-only safety boundary: no send, no mutate, no scheduling
- a design that takes a database connection by injection and is transport-pluggable, so the same logic runs locally and hosted

Cloud owns only the hosting wrapper and consumes the core artifact without reimplementing it:

- the remote transport binding for the MCP server
- bearer-token and per-tenant auth, and routing a connection to the correct tenant database
- secret storage for MCP tokens (encrypted, in Fly/Vercel secrets, per ADR 0007 and `hosted-cloud-contracts.md`)

V1 is read-only. Sending, scheduling, contacts, calendar, CRM hydration, and AI summarization stay out of both surfaces unless a later ADR explicitly adds them. The two surfaces should share one read-tool contract so they do not drift.

## Consequences

- A future agent must not strip the MCP server or agent CLI from core citing ADR 0001's default exclusion. This ADR is the separately accepted exception that decision anticipated.
- Remote, authed, or multi-tenant MCP transport must not be built into the public core. Doing so would pull hosted secrets and tenant auth into the public repo, violating ADR 0007 and `hosted-product-boundary.md`.
- The MCP server and CLI must accept an injected database connection and keep transport behind a boundary, so the local stdio binding and the cloud remote-authed binding share the same tool logic.
- The read-only boundary is a hard contract for v1. Any write capability is a new, separately accepted decision.
- ADR 0001 is amended in effect for read access only; ADR 0007's assignment of remote MCP auth to cloud is unchanged and reinforced.

## Verification

- `docs/agent/feature-list.json` notes for issues #4 and #7 record the core-builds / cloud-hosts split and the read-only boundary.
- GitHub issues #4 and #7 state the transport-and-auth seam.
- `docs/hosted-cloud-contracts.md` and ADR 0007 continue to assign remote MCP auth and MCP token secrets to the private hosted repo.
- When implemented, MCP and CLI tests must prove read-only behavior and database-connection injection, and the public package must not contain a remote transport or auth binding.

## References

- ADR 0001: SupaMail core is email sync only (escape hatch invoked here).
- ADR 0007: Public core hosted cloud contract (remote MCP auth stays in cloud).
- GitHub issues #4 (MCP server) and #7 (agent-first email CLI).
- `docs/hosted-cloud-contracts.md`
- `docs/hosted-product-boundary.md`
