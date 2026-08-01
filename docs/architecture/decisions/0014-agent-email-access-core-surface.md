# ADR 0014: Agent Email Access Is a Core Read Surface

Status: Accepted

Date: 2026-06-04

## Context

Issue #4 (MCP server) and issue #7 (agent-first CLI) both require stable, machine-readable access to mirrored email. Implementing separate query logic for each transport would create drift and inconsistent safety boundaries.

## Decision

Agent email access is a first-class core capability delivered through one shared read contract.

Core owns:

- the MCP tool schemas and implementations;
- deterministic machine-readable CLI output, including sync-trust signals;
- local stdio MCP transport;
- database-connection injection and transport-independent tool logic;
- the read-surface safety contract.

Remote deployments may wrap the shared contract with their own transport, authentication, authorization, and secret storage. Those deployment concerns are not part of this repository's core schema.

Mailbox mutations and sending are separate explicitly accepted capabilities. They do not silently expand the local MCP tool set.

## Consequences

- CLI and MCP reads share one implementation and response contract.
- Remote wrappers can reuse the core without adding deployment-specific authentication to it.
- Tests pin the MCP tool set and prevent unrelated mutation capabilities from appearing there.

## Verification

- `docs/agent/feature-list.json` tracks issues #4 and #7.
- MCP and CLI tests prove deterministic behavior, injected database access, and the bounded tool surface.

## References

- GitHub issues #4 and #7
- `apps/api/src/mcp/`
- `apps/api/docs/AGENT_EMAIL.md`
