# ADR 0054: Every step of a direct action is named

Status: Accepted

## Problem

A host could time an action only as a whole and, for draft saves and updates,
by a few IMAP commands (supamail#249). Everything else an action does was one
unnamed block. In one hosted deployment over 14 days:

- `move_messages` spent 5.5 s at the median inside provider work with no step
  named, including 2.2 s of database time.
- `send_email` spent 2.9 s unnamed: SMTP and filing the Sent copy.
- Saves on one mailbox lost 3.4–8.4 s now and then outside every named
  step. A sync run overlapped only 2 of those 9 saves, so the lock alone did not
  explain it.

Without names, a slow action could only be guessed at.

## Decision

- `action-steps.ts` exports `ACTION_STEPS`, the names of everything a direct
  action spends time on, and `timeStep`. A step may repeat; its durations add up.
  - `db_load`: the rows an action reads first.
  - `compose`: building the message bytes.
  - `db_lock`: waiting for, taking, checking and releasing the account lock.
  - `imap_connect`, `imap_reuse` and `imap_logout`: a login, a parked session's
    check, and ending or parking the session.
  - `imap_list`, `imap_find`, `imap_fetch`, `imap_append`, `imap_store`,
    `imap_move`, `imap_expunge` and `imap_folder`: one IMAP command each.
  - `smtp_send`: the SMTP credentials, the target check and the submission.
  - `db_mirror`: mirror writes: folders marked due, write-through, and a filed
    message's row and body (parsing it and storing it in the host's body store).
- `MailboxActionOptions.onStep` (formerly `onImapStep`) receives every step of
  draft create, update, send and delete, send, flags, moves, message and thread
  verbs, folder changes and attachment downloads. A streamed download logs out
  when its stream closes, after the host may have recorded the request.
- Every IMAP command of an action already ran through `ImapAbortBinding.run`,
  which now takes the step name, so no command run through it can go unnamed.
  The stream download, which used to bypass it, now runs through it too. Login,
  reuse and logout are timed in `connectAbortableImap` and
  `ImapAbortBinding.logout`.
- `withInteractiveAccountLock` times the wait, the acquisition, each
  `assertLive` and the release as `db_lock`. Every write already takes it.
- Database reads and writes, building the message, and SMTP are timed where the
  action calls them.
- `imap_mirror` and `imap_delete` are gone. A filed message's mirror is now
  `imap_fetch` plus `db_mirror`, and a delete is `imap_expunge` plus `db_mirror`,
  so each step is one resource.

What the steps do not cover is the action's own code between them: input
parsing, result shaping and resolving a special-use folder.

## Verification

- Against Dovecot and Postgres, `pnpm smoke:dovecot` checks that a fresh save, a
  reused save, a flag change, a move and a save after 20 s idle each leave under
  50 ms outside their named steps. The measured gaps were 0–1 ms.
- `pnpm smoke:greenmail` checks the same for a send, a draft update and a draft
  send, and that each names its SMTP, fetch, expunge and Sent copy steps.
- Unit tests check the steps a draft save and update report themselves.

## Consequences

- A host records the steps under their own names; the names are fixed and carry
  no content.
- The step list is the contract. A new step means a new name in `ACTION_STEPS`,
  and hosts that keep a list derive theirs from it.
