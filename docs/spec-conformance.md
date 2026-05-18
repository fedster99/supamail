# Spec Conformance

SupaMail was extracted from an older Rackspace IMAP sync design that was used to build the original Signal sync engine. This document is the public, sanitized conformance map: it records which reliability mechanics were imported, how SupaMail implements them, and what proves they work.

The private source context is kept outside the public repo in `.context/old-spec-used-to-build-original-signal-sync-engine.md`.

## Reliability Matrix

| Old spec requirement | SupaMail status | Implementation / proof |
| --- | --- | --- |
| UIDs are scoped by folder and UIDVALIDITY, never globally unique. | Implemented | Message uniqueness is `(account_id, folder_path, uidvalidity, uid)`; `pnpm spec-conformance` covers UIDVALIDITY behavior. |
| Do not run concurrent IMAP operations for the same account. | Implemented | Session advisory locks in `withAccountLock`; live DB tests verify concurrent sync serialization. |
| Detect broken advisory lock/session assumptions. | Implemented | Worker lock self-test verifies session-scoped lock behavior at startup. |
| Recover stale/orphaned account locks. | Implemented | Stale heartbeat recovery scans `pg_locks` and terminates stale backends; live DB tests exercise real `pg_locks`. |
| Initial sync must be resumable and gap-safe. | Implemented | Snapshot + newest-first watermark; spec-conformance runs three-cycle initial sync proof. |
| Do not reconcile unfinished initial sync folders. | Implemented | Reconcile runs only after initial sync completion; health remains `INITIAL_SYNC` while any tracked folder is incomplete. |
| Incremental sync must not advance through partial metadata fetches. | Implemented | Metadata fetch fails if any requested UID is missing; unit coverage pins partial-batch behavior. |
| Reconcile provider deletes and missing-in-DB rows. | Implemented | Temp-table UID stream finds missing local rows and provider-only rows; live DB tests verify `RECONCILE_BACKFILL`. |
| Flag scans are due-based and diff actual flag changes. | Implemented | `applyFlagScan` compares normalized old/new flags, logs `FLAGS_CHANGED`, and does not backfill unknown UIDs. |
| Exclude folder explosions such as Spam/Trash/All Mail by default. | Implemented | Provider profiles exclude dangerous/system folders including SPECIAL-USE `\All` and `All Mail`. |
| Missing folders get a grace period before tombstoning. | Implemented | Folder discovery stamps `missing_since`; past grace marks folder `MISSING` and tombstones in-window rows. |
| UIDVALIDITY resets trigger controlled resync and a rolling reset cap. | Implemented | Reset handler tombstones old rows, resets folder state, and marks account `BROKEN` after the configured 24h cap. |
| Health must not lie. | Implemented | Account health stays `INITIAL_SYNC`/`DEGRADED` until tracked folders, lag, and reconcile state are actually clean. |
| Partial success is not a hard failure when priority folders succeed. | Implemented | Priority failure makes sync failed; round-robin-only failure is `partial_success` and increments success counters. |
| Backoff should be conservative and jittered. | Implemented | Transient failures use jittered exponential backoff; stored backoff resets only after stable success. |
| Retention must preserve recoverable reconcile tombstones. | Implemented | Expiry marks old rows `EXPIRED`; purge only removes strict trapdoor reasons, never `RECONCILE_MISSING`. |
| Account count should be capped for this architecture. | Implemented | `SYNC_MAX_ACCOUNTS` enforced at account creation and worker startup. |
| Body fetches should be lazy and lock-guarded. | Implemented | Body backlog/fetch uses the same account lock and stores full MIME/parser output separately from metadata. |
| CI must prove DB behavior against real Postgres. | Implemented | `pnpm test:db:live` starts disposable Postgres, migrates twice, runs live DB integration tests, then runs spec conformance. |

## Intentionally Out Of Scope

SupaMail keeps the Signal product layer out:

- Relationship CRM tables and interactions.
- Identity, belief, and epistemic architecture layers.
- Signal dashboard/API routes.
- Provider-specific live account tests in CI.

The open-source project owns the mailbox mirror: durable metadata, flags, bodies, folders, sync events, health, and reliability semantics.

## Verification Commands

```bash
pnpm test
pnpm test:db:live
pnpm typecheck
pnpm build
```

`pnpm test:db:live` runs the serious DB reliability gate: disposable Docker Postgres, migration idempotence, live DB integration tests, and spec conformance.
