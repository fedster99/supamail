# ADR 0038: Sync Status Is Its Own Tool; Reads Only Name Their Accounts

Status: Accepted

Date: 2026-10-05

## Context

Every read result (`search_email`, `read_message`, `read_thread`,
`list_folders`) attached a full `sync_trust` block: per-account state, three
progress percentages, `fully_synced`, `results_may_be_incomplete`, and
`degraded_reasons`.

- **Cost.** The live body percentage reads every recent message and its body
  state through `imap_account_progress`. In production that was about 37,000
  buffers (290 MB) and 150–200 ms per call, against 256 MB of shared buffers,
  so cold calls took seconds.
- **Noise.** Agents repeated the block to users on almost every answer.
  Permanent or harmless states (a few truncated bodies, history still storing,
  a delayed but healthy sync) set `results_may_be_incomplete`, so users were
  told the mirror was behind when it was not.
- **Second job.** The block was also how a result named its Mailbox Account
  (`account_email`), which hosts rely on to attribute results.

## Decision

- Read results carry `accounts: [{ account_id, account_email, notice? }]` from
  one indexed read of `imap_accounts`. `notice` appears only when the mailbox
  cannot give a complete answer, as a code hosts can act on without parsing text:
  `first_sync_in_progress` (`INITIAL_SYNC`), `sync_stopped` (`BROKEN`), or
  `sync_paused` (`PAUSED`).
  `DEGRADED`, history backfill, and body progress get no notice.
- `get_sync_status` (MCP tool and `supamail sync-status`) returns per-account
  state and progress (`buildSyncStatus`), `degraded_reasons`, `fully_synced`,
  and a one-line `summary`, all derived from one list of reasons per mailbox.
  An explicit account that matches nothing is `not_found`. It is the only agent
  read tool that queries the progress view. Its description tells agents to
  call it when the user asks about syncing or results seem to be missing.
- `sync_trust` and `buildSyncTrust` are removed; `buildReadAccounts` and
  `buildSyncStatus` replace them.

## Consequences

- A read call no longer touches message or body rows for sync state; it reads
  one account row per mailbox.
- Agents mention sync only when a mailbox really cannot answer, or when asked.
- Breaking change: clients that read `sync_trust` from read results must call
  `get_sync_status` instead. Account attribution moves to `accounts`.
- The summary has one sentence per mailbox that has a reason; when none has,
  it reads "All mail is synced." or "All N mailboxes are synced."
- A DEGRADED mailbox gets no read notice. It may be failing for up to about a
  day before stuck-degraded escalation marks it BROKEN; `get_sync_status`
  reports it as "sync delayed" meanwhile.

## Verification

- `sync-status.test.ts`: which states get a notice, that read accounts never
  query `imap_account_progress`, and the summary for synced, mixed, and empty
  scopes.
- `sync-status.metadata-protection.test.ts`: both builders reveal the account
  email through the metadata adapter.
- `get-sync-status.live-db.test.ts`: a first sync is reported with its summary;
  a non-UUID account is `invalid_input` before any query.
- The read tools' live tests assert `accounts` and the absence of `sync_trust`.
