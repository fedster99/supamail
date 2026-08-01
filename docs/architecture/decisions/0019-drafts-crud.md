# ADR 0019: Draft CRUD Is a Composition of the Send + Organize Primitives, With Update Modeled as Append-New + Delete-Old

Status: Accepted

Date: 2026-06-21

## Context

email-001 (ADR 0017) added the SMTP send path + a write-only Sent APPEND, and
email-002 (ADR 0018) added the organize mutations (mark/star/move/delete, thread
fan-out, folder CRUD) on a write-only `MailboxMutator`. ADR 0016 already gives the
agent surface a *produce-only* `draft_reply` (it composes a threaded reply and
stops — no save, no send).

email-003 needs full draft CRUD saved to the provider **Drafts** folder:
create / list / get / update / send / delete. The Nylas parity gap is that
`draft_reply` produces a draft object but never persists it where a normal mail
client (or the next sync) would see it. The tension is the same as 0014/0016/0017/
0018: deliver mutation value without breaching the zero-send, read-only agent
surface, and without giving the sync read adapter a write verb.

## Decision

Draft CRUD is authored as a new module **outside `src/mcp/`** (`drafts.ts`) that is
**mostly composition** of the existing primitives — no new IMAP write client is
introduced:

- **Create** = email-001 `buildRawMime` (compose RFC-822 bytes) → APPEND to the
  resolved Drafts folder with the `\Draft` flag, via email-001's existing write-only
  `SentFolderAppender` (its `append(path, raw, flags, date)` is already generic;
  we reuse it rather than add a second appender). `\Seen` is also set so a saved
  draft never inflates unread counts. As with the Sent APPEND, we do **not** insert
  a mirror row — the next sync of Drafts mirrors the copy with its server-assigned
  UID, so identity (`folder + UIDVALIDITY + UID`) is never guessed.
- **List / Get** read the **mirror**, not IMAP. Drafts are already-synced messages
  in the Drafts folder (provider-profiles intentionally keeps Drafts mirrored). We
  resolve the draft folder set by `\Drafts` special-use plus the conventional name,
  and also treat any `\Draft`-flagged row as a draft. `get` joins the stored body.
  No IMAP round-trip, so these stay cheap and read-only.
- **Update = APPEND-new + delete-old.** IMAP drafts are immutable: a stored message
  has a fixed server-assigned UID and cannot be edited in place (there is no IMAP
  "replace message" verb). So an update files a fresh draft (the create path) and
  then **hard-deletes the previous one** by reusing the email-002 capability-gated
  delete (`deleteMessage(hard)` → UID-scoped EXPUNGE under UIDPLUS). This is the
  same APPEND-then-supersede pattern real IMAP clients use for "save draft."
- **Send RESENDS the draft's real raw RFC-822 bytes — a true round-trip, NOT a
  rebuild from the mirror's parsed fields (revised; see the addendum below).**
  `sendDraft` fetches the draft's actual stored bytes via email-004 `getRawMime`
  (the mirrored `raw_mime`, or an on-demand UIDVALIDITY-guarded IMAP FETCH from the
  draft's Drafts folder+UID), submits **those exact bytes** over SMTP via email-001
  `deliverSmtp` (reusing `resolveSmtpCreds` + the `assertSafeSmtpTarget` SSRF guard +
  the requireTLS logic), APPENDs **the same bytes** to Sent via `SentFolderAppender`,
  **then** deletes the draft. The SMTP transport + Sent-append are **reused, never
  duplicated** — `drafts.ts` does not touch nodemailer itself. Send refuses a draft
  with no recipients before any delivery. The envelope recipients (MAIL FROM = the
  account email, RCPT TO = To + Cc) come from the **synced header fields**, never the
  lazy body, so recipient handling stays safe. Because the real bytes are resent,
  body + HTML + formatting (and provider-composed attachments) survive **by
  construction** — there is no mirror-body dependence to lose. The same
  per-account advisory lock is acquired before the possibly-live `getRawMime`
  fetch and held across SMTP, Sent APPEND, appender teardown, and best-effort draft
  deletion. Contention therefore raises `AccountBusyError` before any provider
  operation or delivery, and the lock heartbeat stays fresh for its full lifetime.
  Draft raw fetch may take time, so liveness is synchronously re-proven immediately
  before SMTP. Once delivery is confirmed, later liveness loss skips remaining
  provider cleanup and becomes a warning rather than a thrown retry signal.
- **Bcc is rejected on drafts (send-time only).** Bcc cannot round-trip through the
  APPENDed draft bytes — nodemailer's `keepBcc` default omits Bcc from the composed
  MIME, so a Bcc stored on a draft would be silently lost and never sent. Rather
  than accept-and-drop, drafts **reject** Bcc: `DRAFT_SCHEMA` errors with `"Bcc is
  not supported on saved drafts — set Bcc when you send the draft"`, the CLI
  `draft-create`/`draft-update` commands expose no `--bcc`, the `createDraft`/
  `updateDraft` input types omit `bcc`, and the lib re-checks at runtime for an
  untyped caller. Bcc remains fully supported on the email-001 **send** envelope —
  set it when the draft is sent.
- **Delete** reuses email-002 `deleteMessage` directly (trash by default, `\hard`
  EXPUNGE on request), so the blanket-EXPUNGE refusal and UIDVALIDITY guard from
  ADR 0018 apply unchanged — drafts get no new deletion path.

Folder resolution mirrors `resolveSentFolder` / `resolveTrashFolder`: a new
`resolveDraftsFolder` prefers `\Drafts` special-use, then a folder literally named
"Drafts", then the conventional `"Drafts"`.

> Now shared (arch CC-2): the three resolvers are one-line delegations to a single
> role-keyed `resolveSpecialUseFolder(mailboxes, role, profile)` (provider-profiles.ts).
> Each role's exact fallback is preserved — Sent consults the provider profile,
> Trash/Drafts match the leaf name — so behavior is unchanged; the inconsistency now
> lives in one visible per-role line for a future deliberate alignment. The SQL
> `draftFolderPaths` stays a separate encoding (it queries the mirrored folder table,
> not a live LIST).

**Surfaces** follow "one core lib, four front doors": library functions exported
from the barrel; `API_TOKEN`-gated HTTP routes (`POST/GET /accounts/:id/drafts`,
`GET/PATCH/DELETE /drafts/:id`, `POST /drafts/:id/send`); and CLI commands
(`draft-create`, `drafts`, `draft`, `draft-update`, `draft-send`, `draft-delete`,
all `--json`). **`--confirm` is required for `draft-delete` and `draft-send`** —
send is outward-facing, so it mirrors the email-001 send/reply `--confirm` gate.
Unlike send, the draft create/update body schema allows an empty/absent `to` (a
draft may be saved while still incomplete); the recipient requirement is enforced
only when the draft is sent.

The agent MCP surface stays the five read tools (ADR 0014 holds): APPEND + delete
remain outside `src/mcp/`, the sync read adapter gains no write verb, and the
existing `crypto.ts` envelope + `assertSafeImapTarget` SSRF guard are reused via
the primitives. This supersedes the **scope** (not the spirit) of ADR 0014/0016
for `drafts.ts` only, exactly as 0017/0018 did for their modules.

## Consequences

- An operator/agent can create, revise, send, and delete real drafts in the
  provider Drafts folder, while the agent MCP surface stays provably zero-send.
- Draft send can return transient `AccountBusyError` before raw fetch or SMTP when
  sync/direct-send owns the account lock; that outcome is proven-unsent and safe
  for callers to retry according to the HTTP `Retry-After` contract.
- Because create/update do not insert a mirror row, a freshly-created or updated
  draft is not visible to list/get until the next Drafts sync (eventual mirror
  convergence — the same discipline as email-001's Sent APPEND). Update returns the
  superseded draft's id and the new APPENDUID so callers can observe the swap.
- Update produces a brief window where both the old and new draft exist on the
  server (APPEND succeeds, then delete runs). If the delete fails after the APPEND,
  the result is a duplicate draft, not data loss; the next sync reconciles and the
  operator can delete the stale copy.
- Hard delete (EXPUNGE) for update/send requires UIDPLUS (inherited from ADR 0018);
  on a server without it, `deleteMessage(hard)` refuses rather than risk a blanket
  EXPUNGE. Update surfaces that capability error; after confirmed draft delivery,
  send records draft-cleanup failure as a warning instead of throwing.
- Drafts intentionally do **not** carry Bcc — it is a send-time-only field. A future
  change must NOT "re-add" `bcc` to `DRAFT_SCHEMA`, the CLI, or the `DraftInput`
  type as an oversight: Bcc is dropped from the saved bytes by design (nodemailer's
  `keepBcc`), so accepting it on a draft would silently lose recipients. Set Bcc on
  the `send`/`reply` envelope instead.
- Drafts carry neither Bcc nor attachments; both are send-time-only fields.
  `createDraft`/`updateDraft` reject `attachments` because they compose the saved
  bytes via `buildRawMime` from a `DraftInput` that has no attachment-bytes field —
  so a passed attachment would be silently dropped from the SAVED draft. (Note: the
  send-side reason no longer applies — `sendDraft` now resends the draft's RAW bytes,
  so a draft composed elsewhere WITH attachments would round-trip on send. The create
  rejection is independent; see the addendum.) Attach files on the `send` envelope.
- HTML drafts are sent as HTML, never flattened — now automatically, because
  `sendDraft` resends the draft's real bytes (whatever Content-Type/parts they
  carry). The `getDraft` `bodyHtml` + `isHtml` distinction is kept for read/display
  use; it is no longer load-bearing for send (the raw resend preserves markup).
- Downstream deployments inherit draft CRUD via `@supamail/api` and add their
  scoping + the human-confirm MCP wrapper, never editing `imap_*` schema.

## Verification

- `agent-surface-zero-send.test.ts` stays green and unchanged: draft write verbs
  are outside `src/mcp/`, no MCP tool exposes a send/draft-write key, exactly five
  read tools.
- `sync-adapter-read-only.test.ts` stays green: the sync adapter still exposes no
  append/store/expunge (APPEND lives only on `SentFolderAppender`).
- `drafts.test.ts` covers: create APPENDs `\Draft` to the resolved Drafts folder;
  create rejects a smuggled Bcc with the clear message before any connect; update =
  append-new + hard-delete-old; send RESENDS the draft's raw bytes (asserts the bytes
  submitted over SMTP and APPENDed to Sent are the fetched `getRawMime` bytes,
  envelope = the synced To+Cc, deliver-before-delete ordering) and — the empty-body
  regression guard — that the SENT/Sent-APPENDed bytes CONTAIN the draft body even
  when the mirror body row is NULL; refuses a recipient-less draft; rejects lock
  contention before raw fetch/SMTP; holds the lock through SMTP, APPEND,
  graceful/fallback teardown, and cleanup; treats post-delivery APPEND, teardown,
  liveness loss, unlock, and delete failures as warnings; delete reuses the
  email-002 mutation; list/get read the mirror only.
- `api-safety.test.ts` covers the `API_TOKEN`-gated draft routes (create with
  optional recipients, create with `bcc` rejected 400 with the clear message, 404
  for unknown account/draft, list/get/update/send, and the `?hard` delete mapping).
- The GreenMail smoke (`scripts/greenmail-smoke.ts`) creates a draft with a
  distinctive body → resyncs → asserts it appears in Drafts, then sends it →
  reads the DELIVERED message straight off the IMAP server and asserts its body is
  NON-EMPTY and equals the draft body (the end-to-end empty-body proof), and that
  the draft cleanup is removed-or-best-effort (requires Docker).

## References

- ADR 0014: Agent email access is a read-only core surface (the boundary this
  preserves).
- ADR 0016: The reply drafter produces, never sends (the produce-only draft this
  builds persistence + send around).
- ADR 0017: SMTP send/reply primitive + write-only `SentFolderAppender` (reused for
  compose + the Drafts APPEND).
- ADR 0018: Organize mutations + the capability-gated `deleteMessage` (reused for
  delete-old and delete-draft).
- `apps/api/src/drafts.ts`, `apps/api/src/smtp-client.ts`, `apps/api/src/content.ts`
  (`getRawMime`), `apps/api/src/mailbox-mutations.ts`, `apps/api/src/send.ts`.
- RFC 3501 §6.3.11 (APPEND), §2.3.2 (the `\Draft` system flag).

## Addendum (2026-06-24): sendDraft resends the draft's raw MIME

The original "Send" decision had `sendDraft` reconstruct a `SendRequest` from the
mirror's parsed draft fields (`getDraft`'s `body` / `bodyHtml`) and feed it through
`sendMessage`. That rebuild was a **confirmed production bug** (verified live against
a real Rackspace mailbox with a Gmail receipt): under lazy body-fetch a freshly
created or updated draft's BODY may not be mirrored yet (`body` NULL) while its
headers/recipients ARE — so the rebuild **sent an empty email**. A
`draft-create` → `draft-update --body …` → `draft-send` delivered an EMPTY message,
while a direct `send --body …` arrived intact; `delivered: true` never inspected the
content.

**Fix:** `sendDraft` now performs a true round-trip — it resends the draft's ACTUAL
raw RFC-822 bytes (`getRawMime`, which fetches on demand from the draft's
Drafts folder+UID under the UIDVALIDITY guard), submits those exact bytes over SMTP
(`deliverSmtp` + `resolveSmtpCreds` + `assertSafeSmtpTarget` + the same requireTLS
logic), APPENDs the same bytes to Sent, then best-effort deletes the draft. The
envelope recipients still come from the synced header fields (To + Cc), never the
lazy body. This removes the mirror-body dependence entirely, so body + HTML +
formatting (and provider-composed attachments) survive **by construction**. The
"rebuild from the mirror" rationale above — and the body/attachment-loss risk it
implied — no longer applies. At the time of this addendum, `sendMessage` (the
direct-send primitive) was unchanged and only `sendDraft` changed. The SACRED
invariants hold: no `src/mcp/` write verb / no
sixth tool, `agent-surface-zero-send` + `sync-adapter-read-only` green, the frozen
AES-256-GCM envelope untouched.

Open follow-up: the draft-attachment rejection on `createDraft`/`updateDraft` could
now be revisited — `sendDraft` would round-trip attachments present in the draft's
raw bytes — but SupaMail-authored drafts still have no path to carry attachment bytes
into `buildRawMime`, so the create/update rejection stays for now (not lifted here).
