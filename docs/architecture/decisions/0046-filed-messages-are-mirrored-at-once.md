# ADR 0046: A Message An Action Files Is Mirrored At Once

Status: Accepted

Date: 2026-10-26

## Context

ADR 0033 had a saved draft write its row from APPENDUID and values the save
composed, and left the body to the body lane. A sent copy wrote no row at all.
A hosted deployment measured the gap over 14 days to 2026-10-26:

- A draft's body landed a median of 14 s after its row (slowest tenth 50 s).
  `read_message` right after `save_draft` came back partial, with no body, 14
  times across 4 tenants, a median of 4 s after the save; reads about 15 s later
  succeeded.
- The Sent copy of a send landed a median of 16.5 s after the send finished
  (slowest tenth 77 s, slowest 197 s), so a read in that window could not see it.
- The connected servers answer APPEND with APPENDUID, and their RFC822.SIZE
  equals the stored bytes on 2,685 of 2,687 Drafts and Sent rows (the other 2
  were truncated).
- With the row mirrored at once, a reply still joined its conversation only when
  the threading lane next ran. Over 7 days to 2026-10-30, a sent reply was in
  its conversation at most 5.0 s (median) and 14.4 s (75th percentile) after the
  send finished, and never sooner than 1.9 s; a saved reply never sooner than
  1.3 s. A `read_thread` right after the action did not show the agent's reply.

## Decision

After a provider-acknowledged APPEND returns APPENDUID, the action mirrors that
one message as sync would, on its own connection and under the account lock it
already holds with fenced writes. `mirrorFiledMessage` (`filed-message.ts`) does
this for draft create and update, and `fileSentCopy` for the Sent copy of a send
and a draft send.

- **The row is the server's.** The action selects the folder again (it may still
  be selected from before the APPEND), checks that its
  UIDVALIDITY is the APPENDUID's, fetches that UID's metadata with sync's
  `fetchMessageMetadata`, and writes it through sync's `upsertMessages`. The row
  has the server's flags, BODYSTRUCTURE, attachment rows and provider ids. The
  composed-metadata row of ADR 0033 is removed.
- **The body is the filed bytes.** The action already holds the exact bytes it
  filed. When the server reports exactly that many bytes, under
  `BODY_RAW_MAX_BYTES` and the body lane's 4 MiB batch bound, the action parses
  them and stores the body in the body lane's order: evidence, the host's
  `BodyStore`, then `completeBodyStorage`. A larger body, or another byte count,
  is left to the body lane, which streams it on a worker rather than in the
  request. No stored body is fetched again.
  `buildRawMime` writes every line break as CRLF (RFC 5322), as servers store
  a filed message; with bare LF breaks a multi-line body never matched the
  server's byte count (found in production on 2026-10-28: 4 of 5 drafts).
- **Keyed retries.** A keyed save that finds an earlier attempt's copy returns its
  live row id. When that copy has no row yet, the retry mirrors the row only: the
  earlier attempt's bytes may differ from this one's, so its body is left to the
  body lane.
- **The host's body store.** `MailboxActionOptions.bodyStore` takes the store the
  host gives sync; without one the action uses the OSS database store, as sync
  does. Sync hooks do not run; they belong to sync.
- **Narrow guard.** Only a folder that is tracked, not missing, and already read
  by sync at the APPENDUID's UIDVALIDITY qualifies. Without APPENDUID, or without
  such a folder, the next sync mirrors the message as before.
- **Failures never fail the action.** The provider already holds the message. A
  failed read or row write is a warning and leaves no id; a failed body store is
  a warning and keeps the id. Sync repairs both.
- **Sync stays authoritative.** The write leaves `last_uid` unchanged. Sync reads
  the UID again, keeps the row id, and does not fetch a stored body again.
- **The conversation is assigned at once.** After the action releases the
  account lock, `assignFiledMessage` runs the threading lane's incremental step
  for the mirrored message: `ThreadingRepository.assignQueuedMessage` consumes
  that message's ready queue row in the active run and assigns the conversation
  closure it pulls in with the run's own executor, under the lane's per-account
  threading lock and state barrier. It does no lane upkeep: no build runs,
  evidence repair, subject work or failure backoff. It takes that lock only when
  the active run has the message ready, so an account still building its first
  projection stays the lane's. When another session holds the threading lock,
  the account has no live active run or is backing off, queued evidence waits
  for repair, the closure exceeds 500 messages, or a statement or the protection
  work exceeds 1 s, it changes nothing and leaves the message to the lane, as
  before; on a paused account the message waits until threading resumes. A wait
  for a database connection is bounded by the pool, as for the action's other
  steps. It never fails the action and adds no warning; for a send, a thrown
  error would report an unknown delivery outcome. It runs after the account lock
  so the action never holds a second database session while it holds the lock.
- **Send results.** `SendResult.messageId` is the Sent copy's mirror id, or null.
  Both send paths now hold the account lock with fenced writes and use one
  `ActionConnection` for the Sent APPEND and its mirror.

This amends ADR 0017: the send path may read back the one UID the server just
named for it, and nothing else. The sync read adapter still gains no write verb.
It amends ADR 0024: besides the lane, an action may run the incremental step for
the one message it filed.

## Consequences

- A sent copy and a saved draft are readable by their returned mirror id with
  their stored body and attachment metadata before the action returns, when the
  guards above pass, and a reply is in its conversation in `read_thread`. Hosted
  search sees it when its index next drains; the action does not wait for that.
- Each mirrored APPEND costs one SELECT and one FETCH of one UID's metadata on an
  open connection, and one body store write that sync would otherwise do later.
  A draft save reports it as the `mirror` step of `IMAP_STEPS`. An action that
  files a message holds the account lock for that extra time.
- Assigning the conversation adds about 20 ms for a new conversation and about
  140-190 ms for a reply into a 180-200 message one, measured on a local 10,000
  message mailbox; a 500-message closure took 280-360 ms. A conversation over the
  bound fails in about 12 ms and waits for the lane. For a reply, the active run
  then has nothing left for that message; a new conversation still leaves its
  subject work, and a standby or candidate run its own queue row, to the lane.

## Verification

- `filed-message.test.ts`: evidence, the host store and readability happen in the
  body lane's order; mismatched folder identity prevents writes; changed size,
  the byte cap, the 4 MiB bound, no filed bytes and existing bodies skip storage; storage failure keeps the row id;
  mirror failure preserves confirmed Sent filing. Real database and protocol
  tests below cover successful filing rather than repeating it in mocks.
- `drafts.test.ts`, `send.test.ts`: create and both sends hold fenced locks;
  create and update pass the APPENDUID, bytes, socket and host body store to the
  mirror and time it as `mirror`; a keyed retry mirrors only the earlier copy's
  row; both sends pass the delivered bytes and host body store to the Sent filing.
- `drafts.live-db.test.ts`: against real Postgres, a saved draft is readable at
  once with its body, and a later sync upsert keeps its id.
- `filed-thread.live-db.test.ts`: each of send, draft create, update and draft
  send returns with its copy in the original's conversation; with the threading
  lock held, or the state row held past the statement bound, the action still
  succeeds with no warning and the lane assigns the copy later.
- `threading-repository.live-db.test.ts`: the entry's projection is the lane's
  (the lane, given every member again, changes nothing) and leaves the run
  caught up; a closure over the bound, the held lock, a pause and a backoff leave
  the queue row and run unchanged; the lock of an account still building its
  first projection is never taken; a protected account is assigned only through
  its adapter.
- Dovecot smoke: a draft saved with an idempotency key is readable at once with
  its body and BODYSTRUCTURE, and the next sync keeps its id and body.
- GreenMail smoke: a send returns the Sent copy's id, readable at once with its
  In-Reply-To header and in the original's conversation, and the next sync keeps it. GreenMail reports an RFC822.SIZE smaller
  than the stored bytes, so there the body is left to the body lane.

## References

- ADR 0017: the send primitive; amended here.
- ADR 0024: durable conversation threading; amended here.
- ADR 0028: the body store seam and the body lane's storage order.
- ADR 0033: the saved draft row; its composed metadata is superseded here.
- ADR 0043: `ActionConnection`.
- RFC 4315 (UIDPLUS) §3: APPENDUID.
