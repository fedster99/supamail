# ADR 0052: A warning after an accepted change carries a fixed code

Status: Accepted

## Problem

A send or draft action crosses a point after which the change cannot be undone:
SMTP accepted the message, or the provider holds the appended draft. What fails
after that point must not fail the action (a retry would send or file twice),
so it is reported as a warning on a successful result. Sixteen sites wrote
those warnings as free text, each interpolating the provider's or the
database's error message (`Delivered, but filing to Sent failed: <IMAP text>`),
and the account lock added its own, prefixed "The provider already accepted the
change; ...".

A host cannot relay such text to an agent: it carries provider and SQL wording,
and it changes with the libraries. A host that tried to pass it through was
rejected on review for that reason, and a host that hides it hides the fact
too, so an agent that just sent or saved does not learn that the copy, its id
or its body is not there yet. Nor can a host count what happens after
confirmation, by kind. Several of the sixteen told the caller nothing it could
act on: a lock heartbeat that failed after confirmation, an unlock that failed
(the client is evicted either way), an IMAP or SMTP connection that did not
close cleanly. And "the leftover draft self-heals on the next sync" was false:
sync never removes a provider's copy.

## Decision

- **A fixed vocabulary of four codes**, in `errors.ts` beside
  `INPUT_ISSUE_RULES` (ADR 0050): `ACTION_WARNINGS` maps each code to its
  readable sentence, `ACTION_WARNING_CODES` lists them, and
  `actionWarning(code, cause)` builds the one `ActionWarning { code, message }`
  shape, the sentence followed by the cause. Hosts record and relay `code`;
  `message` is the operator's line for the CLI and the HTTP API and may carry
  provider or database text. No emission site writes text of its own.
  - `sent_copy_missing`: delivered, but this action filed no copy to Sent. The
    APPEND failed, or the lock was no longer live and filing was skipped. The
    provider may have filed its own copy; the next sync mirrors it if so.
  - `mirror_pending`: the copy (a Sent copy or a draft) is in the mailbox but
    has no mirror row yet; its id comes with the next sync.
  - `body_pending`: the row and its id exist; the next body run stores the body.
  - `draft_kept`: a draft this action should have removed is still in Drafts,
    the version an update replaced or the draft that was just sent. Sync never
    removes a provider copy; the User deletes it.
- **Where each is raised.** `fileSentCopy` and `mirrorFiledMessage`
  (filed-message.ts) raise `sent_copy_missing`, `mirror_pending` and
  `body_pending` for a send and a draft save alike. `sendMessage` and
  `sendDraft` raise `sent_copy_missing` when the lock is no longer live after
  delivery, and `sendDraft` then raises `draft_kept` too, since it removes
  nothing on a lock it does not hold; `sendDraft` raises `draft_kept` when the
  delete fails, and `updateDraft` when removing the replaced version fails;
  `saveDraft` raises `mirror_pending` when the mirror write fails. Each code is
  raised at most once per result by construction, so no deduplication exists.
- **One list per result.** `SendResult.warnings`, `CreateDraftResult.warnings`
  and `SendDraftResult.warnings` are `ActionWarning[]`. `SendDraftResult.send`
  is `Omit<SendResult, "warnings">`: the warnings of a sent draft were copied
  onto the nested send as well, and now live only on the result.
- **Lock and teardown faults after confirmation are not warnings.** Removed:
  `AccountLockOptions.onPostIrreversibleWarning` and the lock's three
  post-confirmation warnings (final heartbeat refresh, heartbeat error,
  unlock failure), `deliverSmtp`'s `onPostDeliveryWarning` (transport close),
  and the two IMAP connection close warnings. After `confirmIrreversible()`
  every mirror write runs on the fenced lock session (ADR 0042), so a lock the
  holder lost shows as the step that failed on it (`mirror_pending`,
  `body_pending`, `draft_kept`), and the result stands; a failed unlock still
  evicts the client. A connection that did not close is not a fact about the
  mail. Before confirmation nothing changes: those faults still fail the
  operation.
- **Surfaces.** The HTTP API and CLI return the typed items where they returned
  strings; the stdio MCP server has no send tools. `draft_reply`'s compose
  `warnings` (search-style strings about the reply's inputs) is a different
  field and unchanged.

## Consequences

- A host shows each code in its own fixed words and a next step, and counts
  warnings by code, without reading `message`. An agent that sent or saved
  learns, in words it can act on, what is not there yet and that the action
  must not be repeated.
- The elements of `warnings` change from strings to objects, and a sent
  draft's `send` has no `warnings`: a breaking change for API and CLI readers,
  made at once, with no compatibility shim.
- Six of the sixteen emissions are gone, with the lock and SMTP callback
  options, the lock's prefix and deduplication, and every inline sentence.
- A new condition after an accepted change must name one of these codes or add
  a code to the vocabulary; it never writes text at the site.

## Verification

- `errors.test.ts`: the codes equal the vocabulary's keys, in order;
  `actionWarning` puts the sentence before an Error's message or a non-Error
  cause.
- `send.test.ts`: a failed APPEND and lost liveness each give one
  `sent_copy_missing` with the cause; a teardown failure after delivery gives a
  delivered result with no warning.
- `drafts.test.ts`: a failed body store on a save is `body_pending`, a failed
  mirror write `mirror_pending`; a failed delete on an update or after a sent
  draft is one `draft_kept`, and the nested send has no `warnings`; lost
  liveness after a sent draft gives exactly `sent_copy_missing` then
  `draft_kept`, with no APPEND and no delete; a teardown failure gives no
  warning.
- `locks.test.ts`: an unlock that fails after confirmation returns the value
  and evicts the client, with no callback. `smtp-client.test.ts`: a transport
  close failure after acceptance returns the receipt.
- `api-safety.test.ts`: the HTTP send and draft-send bodies carry the typed
  items.
