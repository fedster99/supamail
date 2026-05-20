#!/usr/bin/env node

console.log([
  "Docs / harness impact reminder:",
  "- Check whether this change made project docs or agent instructions stale.",
  "- Harness means the agent-facing workflow docs: AGENTS.md, docs/agent, verification docs, architecture/ADR docs, deployment/schema docs, README, and session handoff.",
  "- Update the relevant docs, or record in the PR Harness Impact section that no docs update was needed."
].join("\n"));
