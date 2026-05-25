# ADR 0001: SupaMail Core Is Email Sync Only

Status: Accepted

Date: 2026-05-18

## Context

SupaMail was extracted from a larger Signal system. The original context included CRM hydration, identity resolution, belief, dashboard, Trigger.dev, MCP, and other product layers. The open-source SupaMail project needs a tighter boundary so the sync engine stays reusable and reliable.

## Decision

SupaMail core owns the mailbox mirror only:

- IMAP accounts and folders
- message metadata
- flags
- raw and parsed MIME bodies
- attachment metadata
- sync runs and sync events
- health, lag, retries, backoff, and retention semantics

SupaMail core does not own CRM, CRM hydration, person/company identity resolution, handle mapping, belief modeling, calendar, contacts, sending, scheduling, AI workflows, MCP, or internal dashboard logic unless a future issue explicitly adds a separate package/process.

References to message identity in SupaMail mean mailbox-row identity only: `(account_id, folder_path, uidvalidity, uid)`. They do not authorize identity hydration, relationship modeling, activity construction, or other CRM-layer behavior in the core package.

## Consequences

- The sync engine stays boring and operationally focused.
- Follow-up products can consume SupaMail tables without coupling back into the core.
- Agents must reject opportunistic product-layer additions while working in core sync code.
- If a future CRM or identity system consumes SupaMail data, it should live outside this core package or behind a separately accepted ADR.

## Verification

- `README.md` project status states the scope boundary.
- `docs/spec-conformance.md` lists Signal product layers as intentionally out of scope.

## References

- `README.md`
- `docs/spec-conformance.md`
- GitHub issues `#2`, `#3`, `#4` for explicit follow-up scope.
