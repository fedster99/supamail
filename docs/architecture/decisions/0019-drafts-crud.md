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
- **Send** loads the draft from the mirror, reconstructs a `SendRequest`
  (To/Cc/Subject + body + In-Reply-To/References), calls email-001 `sendMessage`
  (which delivers over SMTP and files a copy to Sent), **then** deletes the draft.
  The SMTP path is **reused, never duplicated** — `drafts.ts` imports `sendMessage`
  and does not touch nodemailer/SMTP itself. Send refuses a draft with no
  recipients before any delivery. **Body format is preserved on send:** `getDraft`
  surfaces both the plaintext `body` and the original `bodyHtml` + an `isHtml` flag
  (derived from `selected_text_format`), and `sendDraft` sends an HTML draft with
  `body: { format: "html", html }` rather than flattening it through `htmlToText`.
  An HTML-authored or HTML-synced draft therefore goes out with its links and
  formatting intact, not as lossy plaintext.
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
  EXPUNGE, so update/send surface that capability error instead of silently
  purging.
- Drafts intentionally do **not** carry Bcc — it is a send-time-only field. A future
  change must NOT "re-add" `bcc` to `DRAFT_SCHEMA`, the CLI, or the `DraftInput`
  type as an oversight: Bcc is dropped from the saved bytes by design (nodemailer's
  `keepBcc`), so accepting it on a draft would silently lose recipients. Set Bcc on
  the `send`/`reply` envelope instead.
- Drafts carry neither Bcc nor attachments; both are send-time-only fields. email-004
  (ADR 0020) likewise rejects `attachments` on a saved draft — attachment bytes are
  never mirrored, so `sendDraft` (which rebuilds the SendRequest from the mirror)
  would drop them silently. Attach files on the `send` envelope instead.
- HTML drafts are sent as HTML, never flattened. `getDraft` carries `bodyHtml` +
  `isHtml` precisely so `sendDraft` can preserve the original markup; a future change
  must keep that distinction rather than hardcoding `format: "plain"` again.
- The cloud re-pin inherits draft CRUD via `@supamail/api`; cloud adds tenant
  scoping + the human-confirm MCP wrapper, never editing `imap_*` schema.

## Verification

- `agent-surface-zero-send.test.ts` stays green and unchanged: draft write verbs
  are outside `src/mcp/`, no MCP tool exposes a send/draft-write key, exactly five
  read tools.
- `sync-adapter-read-only.test.ts` stays green: the sync adapter still exposes no
  append/store/expunge (APPEND lives only on `SentFolderAppender`).
- `drafts.test.ts` covers: create APPENDs `\Draft` to the resolved Drafts folder;
  create rejects a smuggled Bcc with the clear message before any connect; update =
  append-new + hard-delete-old; send calls `sendMessage` then deletes (ordering
  asserted), refuses a recipient-less draft, and sends an HTML draft with
  `format: "html"` and the real HTML body (not the `htmlToText` flattening); delete
  reuses the email-002 mutation; list/get read the mirror only.
- `api-safety.test.ts` covers the `API_TOKEN`-gated draft routes (create with
  optional recipients, create with `bcc` rejected 400 with the clear message, 404
  for unknown account/draft, list/get/update/send, and the `?hard` delete mapping).
- The GreenMail smoke (`scripts/greenmail-smoke.ts`) creates a draft → resyncs →
  asserts it appears in Drafts, then sends it → asserts it leaves Drafts and lands
  in Sent (requires Docker).

## References

- ADR 0014: Agent email access is a read-only core surface (the boundary this
  preserves).
- ADR 0016: The reply drafter produces, never sends (the produce-only draft this
  builds persistence + send around).
- ADR 0017: SMTP send/reply primitive + write-only `SentFolderAppender` (reused for
  compose + the Drafts APPEND).
- ADR 0018: Organize mutations + the capability-gated `deleteMessage` (reused for
  delete-old and delete-draft).
- `apps/api/src/drafts.ts`, `apps/api/src/smtp-client.ts`,
  `apps/api/src/mailbox-mutations.ts`, `apps/api/src/send.ts`.
- RFC 3501 §6.3.11 (APPEND), §2.3.2 (the `\Draft` system flag).
