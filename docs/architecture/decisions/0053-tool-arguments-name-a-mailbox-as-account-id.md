# ADR 0053: Tool arguments name a mailbox as `account_id`

Status: Accepted

## Problem

Every result names a mailbox as `account_id`: `list_accounts` in the hosted
surface, search identities, and the `accounts` each read returns. The read
tools that take a mailbox scope (`read_thread`, `list_folders`,
`get_sync_status`) asked for it as `account`, and the hosted tools that act on
mail ask for `account_id`. An agent that reuses the field it was given spells
it wrong on the reads, and the strict schemas refuse the call as an unknown
key. The hosted request ledger (ADR 0050) records such rejections in
production. `list_folders` also accepted any string, so a scope that was not a
UUID reached Postgres and failed as a cast error instead of a typed rejection.

## Decision

- **`account_id` is the name.** The three read tools take `account_id`, a UUID,
  and publish only that property. Their descriptions, hints, messages and typed
  issues say `account_id`.
- **`account` stays accepted.** A cached copy of a tool keeps working: the
  request schemas accept `account` with the same validation, and
  `mailboxScope()` reads whichever is present. Both may be given only when they
  agree; two different mailboxes are a `constraint` on `account_id`.
- **One definition.** `mcp/shared.ts` owns the scope fields, the agreement
  rule, the reader and the published property, so a fourth tool cannot drift.
- **Search keeps `accounts`.** It scopes to a list or `all`, a different shape.
- **First-party callers use the name.** The CLI's `thread`, `folders` and
  `sync-status` commands take `--account-id`, as the sync commands already did.
- **The alias is not published and not measured.** A fresh tool copy never
  sends `account`, so publishing it would only invite a second spelling. Its use
  by stale copies cannot be counted while it is accepted; if it is ever removed,
  the hosted ledger counts the fallout as `unknown_key` on these tools, which is
  the measurement that decides whether to keep it removed.

## Consequences

- Agents can pass the id they were given everywhere. Nothing a working client
  sends today is refused.
- `list_folders` now rejects a non-UUID scope as `invalid_input` (`format`)
  before any query, instead of a database error.
- Hosts that read the typed issues see `account_id` where they saw `account`.

## Verification

- `read-thread.test.ts`: `account_id` scopes a conversation selector; a
  missing scope is reported as `account_id`; two different scopes are refused.
- `list-folders.test.ts`, `get-sync-status.test.ts`: a non-UUID scope and two
  disagreeing scopes are refused before a connection; either spelling scopes
  the folder query to the one mailbox.
