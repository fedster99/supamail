# ADR 0045: A Message An Action Files Is Mirrored At Once

Status: Accepted

Date: 2026-10-18

## Context

ADR 0033 had a saved draft write its row from APPENDUID and values the save
composed, and left the body to the body lane. A sent copy wrote no row at all.
A hosted deployment measured the cost over 14 days:

- A sent copy reached the mirror a median of 28 seconds after the send, and 182
  of 880 took more than a minute. 47 of 112 agent sends were followed by a read
  within two minutes; a read that cannot see the reply invites a second one.
- Bodies of rows that sync wrote arrived a median of 3 seconds later. Bodies of
  rows that a draft save wrote arrived a median of 183 seconds later, and the
  slowest tenth after 18 minutes. Nothing woke the body lane for them, so they
  waited for the next full sync pass. Until then a draft could not be read,
  searched, or updated without its body.
- On every connected server, most saved drafts reached the mirror within ten
  seconds of the save, which only the APPENDUID write does. The servers answer
  APPEND with APPENDUID.

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
  filed. When the server reports exactly that many bytes and they are under
  `BODY_RAW_MAX_BYTES`, the action parses them and stores the body in the body
  lane's order: evidence, the host's `BodyStore`, then `completeBodyStorage`.
  Otherwise the body lane stores the body as before. No body bytes are fetched
  again.
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
- **Send results.** `SendResult.messageId` is the Sent copy's mirror id, or null.
  Both send paths now hold the account lock with fenced writes and use one
  `ActionConnection` for the Sent APPEND and its mirror.

This amends ADR 0017: the send path may read back the one UID the server just
named for it, and nothing else. The sync read adapter still gains no write verb.

## Consequences

- A sent copy and a saved draft are readable by their returned mirror id with
  their stored body and attachment metadata before the action returns, when the
  guards above pass. Search indexing and derived conversation assignment still
  follow their existing processing paths; this change does not wait for them.
- Each mirrored APPEND costs one SELECT and one FETCH of one UID's metadata on an
  open connection, and one body store write that sync would otherwise do later.
- An action that files a message holds the account lock for that extra time.

## Verification

- `filed-message.test.ts`: the row comes from the server's metadata for the named
  UID; the body comes from the filed bytes in the body lane's order, with or
  without raw retention; an untracked, unread, or other-UIDVALIDITY folder reads
  nothing and writes nothing; another byte count or a body at the cap leaves the
  body to the body lane; a failed body store keeps the id; Sent filing and mirror
  failures are warnings.
- `drafts.test.ts`, `send.test.ts`: create, update and both sends hold fenced
  locks; create and update pass the APPENDUID, bytes, socket and host body store
  to the mirror; both sends pass the delivered bytes and host body store to the
  Sent filing.
- `drafts.live-db.test.ts`: against real Postgres, a saved draft is readable at
  once with its body, and a later sync upsert keeps its id.
- Dovecot smoke: a draft saved with an idempotency key is readable at once with
  its body and BODYSTRUCTURE, and the next sync keeps its id and body.
- GreenMail smoke: a send returns the Sent copy's id, readable at once with its
  In-Reply-To header, and the next sync keeps it. GreenMail reports an RFC822.SIZE smaller
  than the stored bytes, so there the body is left to the body lane.

## References

- ADR 0017: the send primitive; amended here.
- ADR 0028: the body store seam and the body lane's storage order.
- ADR 0033: the saved draft row; its composed metadata is superseded here.
- ADR 0043: `ActionConnection`.
- RFC 4315 (UIDPLUS) §3: APPENDUID.
