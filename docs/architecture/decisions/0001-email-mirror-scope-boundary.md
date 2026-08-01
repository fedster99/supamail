# ADR 0001: SupaMail Core Owns Reusable Mailbox Infrastructure

Status: Accepted

Date: 2026-05-18

## Context

SupaMail needs a clear boundary so its mailbox engine remains reusable and reliable across self-hosted deployments and downstream applications.

## Decision

SupaMail core owns reusable mailbox infrastructure:

- IMAP accounts and folders
- message metadata, flags, and MIME bodies
- attachment metadata and content access
- mailbox search and protocol conversation threading
- sync runs, events, health, lag, retries, and retention
- generic API, CLI, MCP, and mailbox-operation surfaces

Application-specific business models, identity systems, dashboards, and account orchestration are outside the core.

Message identity in SupaMail means mailbox-row identity: `(account_id, folder_path, uidvalidity, uid)`. Derived delivery and conversation identities do not replace it.

## Consequences

- The sync engine stays operationally focused and reusable.
- Downstream applications can consume SupaMail without coupling their business domain back into the core.
- New generic mailbox capabilities require explicit public contracts and verification.

## Verification

- `README.md` states the public scope.
- `docs/spec-conformance.md` records the reliability contract.

## References

- `README.md`
- `docs/spec-conformance.md`
