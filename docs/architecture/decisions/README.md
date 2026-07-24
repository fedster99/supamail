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
- `0015-search-layer.md`: Search is a pure-Postgres read layer (extended by email-005 with composable structured field/state/date/folder filters across MCP/CLI/REST, no sixth MCP tool).
- `0016-draft-produce-only.md`: The reply drafter produces a threaded draft and never sends.
- `0017-send-primitive.md`: SMTP send/reply is a single reusable primitive authored outside the agent surface; the agent surface stays zero-send and the sync adapter stays read-only.
- `0018-organize-mutations.md`: Mark/star/move/delete + thread fan-out + folder CRUD are UID-addressed write-only verbs outside the agent surface; the mirror reconciles on the next sync.
- `0019-drafts-crud.md`: Draft CRUD (create/list/get/update/send/delete) saved to the provider Drafts folder is a composition of the send + organize primitives; update is append-new + delete-old (IMAP drafts are immutable); the agent surface stays zero-send.
- `0020-attachments-content.md`: Attachment bytes + raw MIME are on-demand UIDVALIDITY-guarded reads (never mirrored under parsed_only); metadata/headers/clean-bodies come from the mirror; all live outside the agent surface (no sixth MCP tool); clean-body is deterministic (no LLM).
- `0021-provider-presets.md`: Long-tail IMAP/SMTP presets (Fastmail/Zoho/iCloud/Yahoo) carry both coordinate sets on `ProviderProfile`; a pure static email-domain lookup autodiscovers the preset at connect time (explicit input always wins); connectivity config only — no new MCP tool, frozen crypto + `resolveSmtpCreds` order untouched.
- `0022-shared-imap-connect-prelude.md`: The four IMAP clients' copied connect prelude (SSRF guard + decrypt + ImapFlow construct + connect) is extracted to one shared `connectImap` (`imap-connect.ts`) with the close-on-connect-error guard baked in (fixing a socket-leak drift on two of the four); the UIDVALIDITY fail-closed comparison is co-located and shared; verb surfaces stay separate — behavior-preserving.
- `0023-sent-freshness-lane.md`: Sent metadata refreshes on a supplemental 30-second cadence that preserves Inbox-first full-sweep ordering and skips expensive secondary lanes and full-account health transitions.
- `0024-durable-conversation-threading.md`: Delivery copies and RFC reply graphs become a stored, account-scoped, versioned, rebuildable conversation projection with conservative provider/subject fallbacks.
- `0025-structured-message-evidence.md`: Decoded MIME yields bounded attachment/calendar/provider-resource evidence for downstream use without introducing semantic work-item clustering into SupaMail.
- `0026-post-repair-reconcile-health.md`: Reconcile gap counts describe observed drift, while account health describes the post-repair mirror state.
- `0027-mutable-body-policy-row-accurate-coverage.md`: Existing accounts can change live body policy, while current complete message rows define live and priority body coverage.
- `0028-content-extract-body-store-seam.md`: A 32 KiB plain-text extract and threading evidence commit before the pluggable body store receives the full payload.

## Status Values

- Proposed: under discussion, not yet binding.
- Accepted: binding until superseded.
- Superseded: replaced by a newer ADR.
- Rejected: recorded option was deliberately not chosen.
