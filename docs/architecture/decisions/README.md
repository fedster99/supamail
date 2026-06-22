# Architecture Decision Records

ADRs record durable decisions that coding agents should not rediscover or casually reverse.

## Index

- `0000-adr-template.md`: Template for new decisions.
- `0001-email-mirror-scope-boundary.md`: SupaMail core is email sync only.
- `0002-node-side-credential-encryption.md`: IMAP credentials are encrypted in Node, not with SQL helper functions.
- `0003-session-affine-postgres-advisory-locks.md`: Account serialization relies on session-scoped advisory locks.
- `0004-temp-table-reconcile-uid-stream.md`: Reconcile streams provider UIDs through a Postgres temp table.
- `0005-live-db-reliability-lane.md`: Live Postgres behavior is verified through a Docker-backed reliability gate.
- `0006-use-harness-impact-reminder-before-pr-updates.md`: Pre-push verification reminds agents to review project docs and harness impact.
- `0007-public-core-hosted-cloud-contract.md`: Public core publishes the pinned image, public migrations, and runtime contracts consumed by private hosted cloud.
- `0008-cooperative-account-lock-budget.md`: Account lock hold time is enforced cooperatively at safe sync boundaries.
- `0009-stuck-degraded-escalation.md`: Long-stuck degraded accounts escalate to retryable, then terminal, broken states.
- `0010-folder-count-cap-priority-tracking.md`: Large folder counts warn first, then enforce priority-only tracking with automatic recovery.
- `0011-pending-verification-folder-state.md`: Missing-mailbox verification uses a scheduler-excluded folder state.
- `0012-three-lane-history-engine.md`: Historical backfill runs after hot sync and live body fetch under the same account lock.
- `0013-imap-compatibility-contract.md`: Generic IMAP support is a stated contract validated by provider-shape fixtures, real-server smokes, and manual matrix entries.
- `0014-agent-email-access-core-surface.md`: The MCP server and agent CLI are built in core as a read-only surface; cloud only adds remote transport and auth.
- `0015-search-layer.md`: Search is a pure-Postgres read layer.
- `0016-draft-produce-only.md`: The reply drafter produces a threaded draft and never sends.
- `0017-send-primitive.md`: SMTP send/reply is a single reusable primitive authored outside the agent surface; the agent surface stays zero-send and the sync adapter stays read-only.
- `0018-organize-mutations.md`: Mark/star/move/delete + thread fan-out + folder CRUD are UID-addressed write-only verbs outside the agent surface; the mirror reconciles on the next sync.
- `0019-drafts-crud.md`: Draft CRUD (create/list/get/update/send/delete) saved to the provider Drafts folder is a composition of the send + organize primitives; update is append-new + delete-old (IMAP drafts are immutable); the agent surface stays zero-send.

## Status Values

- Proposed: under discussion, not yet binding.
- Accepted: binding until superseded.
- Superseded: replaced by a newer ADR.
- Rejected: recorded option was deliberately not chosen.
