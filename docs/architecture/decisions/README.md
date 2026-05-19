# Architecture Decision Records

ADRs record durable decisions that coding agents should not rediscover or casually reverse.

## Index

- `0000-adr-template.md`: Template for new decisions.
- `0001-email-mirror-scope-boundary.md`: SupaMail core is email sync only.
- `0002-node-side-credential-encryption.md`: IMAP credentials are encrypted in Node, not with SQL helper functions.
- `0003-session-affine-postgres-advisory-locks.md`: Account serialization relies on session-scoped advisory locks.
- `0004-temp-table-reconcile-uid-stream.md`: Reconcile streams provider UIDs through a Postgres temp table.
- `0005-live-db-reliability-lane.md`: Live Postgres behavior is verified through a Docker-backed reliability gate.

## Status Values

- Proposed: under discussion, not yet binding.
- Accepted: binding until superseded.
- Superseded: replaced by a newer ADR.
- Rejected: recorded option was deliberately not chosen.
