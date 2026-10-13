# ADR 0043: Every Pass Records Mailbox State, With Explicit Pass Modes

Status: Accepted

Date: 2026-10-13

## Context

Only the full pass recorded a Mailbox Account's state. The Sent, live, and
body-only passes ended in `markAccountSyncYielded` whether they succeeded or
failed, so their failures never moved backoff and never marked a rejected
password BROKEN. A host that schedules each lane separately, and drops the
periodic full pass, therefore had no pass that recorded health at all.

Hosts also had no explicit way to run first sync, history, flag scans, or
audits on their own: those ran only inside the full pass.

Two existing rules constrain the fix. The live lane must not move the
full-sync schedule (`last_sync_finished_at`), which the worker and hosts read
to pace full passes. ADR 0023 kept a Sent success from refreshing account
health, so a Sent success could not hide a failing Inbox.

## Decision

`syncAccount` takes one `mode`: `full` (the default, every lane), `live`,
`sent`, `first_sync`, `body`, `history`, `flag_scan`, or `audit`. The modes
replace the `sentOnly`, `liveInboxOnly`, and `bodyBacklogOnly` booleans.
Options a mode does not run are rejected with `InvalidInputError` before a
run is recorded.

Every mode ends the way a full pass does. Success recomputes health from folder
state and clears backoff, and a partial success records DEGRADED. A failure is
classified as auth (terminal BROKEN), transient (backoff), or BROKEN at the
failure threshold or the stuck-degraded limit. A proven lost lock or an already
finalized account still writes nothing.

Only a full pass moves `last_sync_finished_at`.

A success resets the failure streak, clears backoff, and moves
`last_priority_sync_succeeded_at` only when no tracked priority folder's last
sync is unfinished. An unfinished sync is a folder past its first sync whose
status is still `SYNCING`. That status is durable per-folder evidence that the
folder's last sync started and failed. A Sent or body success therefore cannot
reset the backoff or the stuck-degraded anchor that a failing Inbox set. This
replaces ADR 0023's rule that Sent passes skip health.

Finalization accepts optional host freshness. Per folder path, it is the last
time the host proved the provider equal to the folder's committed cursor.
Health counts a folder's lag from the later of that proof and its last sync,
clamped to the database clock. Without it, lag counts from the last sync, as
before.

`first_sync` runs discovery when due, then one batch, newest mail first, from
each folder whose first sync is incomplete. `flag_scan` and `audit` take due
folders from `next_flag_scan_at` and `next_reconcile_at`, under the existing
per-pass caps. With nothing due, `sent`, `flag_scan`, and `audit` neither log
in nor change health.

Orphaned-run cleanup is `MirrorEngine.closeOrphanedSyncRuns`. Holding the
account lock proves no other pass is live. It does no provider work, so it
records no run and no account state. The full pass keeps running the same
cleanup for core's own worker.

## Consequences

- A host can drop its periodic full pass without losing health, backoff, or
  auth classification.
- A live failure now sets backoff. A host that gates passes on `backoff_until`
  pauses that mailbox's lanes until it passes.
- A folder that fails while other lanes succeed keeps its failure streak and
  anchor, so it still reaches BROKEN at the threshold or after 24 h of stuck
  DEGRADED.
- Hosts must replace the removed booleans (`liveInboxOnly` → `mode: "live"`,
  `bodyBacklogOnly` → `mode: "body"`).
- A no-op `flag_scan` or `audit` pass still records a sync run. A host should
  call it when its due times say so.

## Verification

- `pass-modes.integration.test.ts` runs every mode on real Postgres. Each one
  records success and clears backoff, and each classifies auth, transient, and
  threshold-BROKEN failures. It also proves:
  - an unfinished Inbox survives a Sent success;
  - host freshness keeps a quiet mailbox HEALTHY;
  - each mode runs only its lane;
  - cleanup closes orphans without a run;
  - invalid options are rejected before a run.
- The existing live-lane tests prove a live or body pass leaves
  `last_sync_finished_at` alone.

## References

- ADR 0008: cooperative account-lock budget.
- ADR 0009: stuck-degraded escalation.
- ADR 0023: bounded Sent freshness lane (amended).
- ADR 0031: host-owned Inbox IDLE wake (amended: the live lane now records
  health).
- `apps/api/src/sync-engine.ts`, `apps/api/src/repository.ts`
