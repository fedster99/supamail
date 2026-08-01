#!/usr/bin/env node

console.log([
  "Documentation impact reminder:",
  "- Check whether this change made public docs or contributor instructions stale.",
  "- Review AGENTS.md, docs/agent, architecture/ADR docs, deployment/schema docs, and README as relevant.",
  "- Update the affected docs or record why no documentation update was needed."
].join("\n"));
