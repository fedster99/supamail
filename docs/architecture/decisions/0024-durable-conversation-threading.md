# ADR 0024: Conversation Threading Is a Rebuildable RFC-Derived Projection

Status: Accepted

Date: 2026-07-13

## Context

SupaMail already mirrors `Message-ID`, `In-Reply-To`, `References`, and provider
thread IDs, but it reconstructs a thread at read time with a seed-dependent
one-hop query. A three-message chain can therefore return different members
depending on which message seeded the read. Generic IMAP search groups no replies
at all, mirrored folder copies inflate counts, and the same heuristic controls
whole-thread flag/move fan-out.

Email has three different identities which must not be collapsed:

- a mailbox row is `(account_id, folder_path, uidvalidity, uid)`;
- a delivery is one wire message which may have several mailbox-row copies;
- a conversation is a connected reply graph of deliveries.

Task/document similarity is a separate product concern and is not part of
SupaMail conversation threading.

## Decision

Threading is a normal, deterministic derived projection in the public SupaMail
database. Raw mirror rows remain the mailbox source of truth.

### Protocol graph first

- Parse syntactically valid RFC `msg-id` tokens and compare their canonical form
  case-sensitively. The legacy lowercased `message_id_normalized` remains for
  compatibility but is not conversation truth.
- Valid `References` supplies the ancestry chain. Only when it has no valid ID do
  we use the first valid `In-Reply-To` ID, matching RFC 5256's conservative rule.
- Referenced IDs without a mirrored message become structural placeholders. Two
  children of the same missing parent share a conversation; a parent arriving
  later materializes that placeholder instead of starting a new thread.
- Build the full transitive component with deterministic ordering and cycle
  guards. Deleted mailbox rows remain usable as graph evidence so expunging a
  parent does not split its surviving children.

### Delivery copies before conversations

Use an account-scoped provider message ID (`OBJECTID`/`X-GM-MSGID`) when
available. Otherwise a strict RFC Message-ID identifies a copy candidate, but
multiple physical rows collapse only when an exact complete-MIME fingerprint
corroborates it; uncorroborated or conflicting owners stay separate rather than
hiding unrelated mail from a broken sender that reused an ID. Rows without either
identity use mailbox-row identity. Reads/search count one verified logical
delivery; IMAP mutations still target every live mailbox row.

### Bounded fallback evidence

Provider thread IDs (`OBJECTID`/`X-GM-THRID`) are strong, account-scoped
conversation membership hints but never invent a parent edge. A provider ID is
namespaced by its source.

Subject fallback is deliberately narrow: only an otherwise-unlinked, non-bulk,
non-automated message beginning with `Re:` may attach; the RFC base subject must
match, sender/recipient addresses must cross-match exactly, the prior candidate
must be within 14 days, and exactly one candidate conversation may qualify.
Forwards never subject-merge. Content similarity is never conversation evidence.

### Stored, explainable, reversible assignments

`imap_thread_assignments` stores the delivery key, account-scoped conversation
ID, root/parent reference, reference tokens, fixed assignment method, coarse
confidence tier, provisional state, evidence, input hash, generation, and
algorithm version for each physical message row and algorithm run. It is a
replaceable projection, not a mutation of the raw email.

Thread-relevant metadata changes enqueue the physical message. The drainer
recomputes the affected closure (referenced/referencing deliveries, provider
group, and prior conversation) rather than rescanning the account. The closure
has independent row, logical-evidence-byte, and criteria-key budgets; the
subject bucket and write batch also have hard caps. If a previously accepted
weak subject bucket later grows beyond its cap, the worker first dissolves the
old weak edges in bounded components. Work is serialized per account, retries
are persisted before releasing the account lock, and processing is idempotent
per run.

An initial build, explicit rebuild, or algorithm upgrade creates an isolated
shadow run. It keyset-scans body evidence and protocol edges in bounded
transactions, drains per-run changes that arrived during the scan, and stops at
`ready`. Readers continue through `imap_thread_active_assignments`, which joins
only the account's active-run pointer. A comparison stores merge/split,
provisional, coverage, and method deltas for exact baseline/candidate
generations at one evidence revision. Replacing an active run requires that
certificate to pass explicit thresholds. Activation takes the state row
exclusively, proves full physical-row coverage, an equal evidence revision, and
empty catch-up queues, then changes that single pointer. READ COMMITTED is used
deliberately: after waiting for an in-flight writer, activation must see the
writer's commit. A new release retains the previous version's pure executor so
active, candidate, and rollback runs can all remain caught up during rollout;
the production registry is literal/versioned, and startup plus direct operator
paths fail before processing if a state-referenced executor is missing. An older
binary therefore neither ignores nor supersedes a newer candidate silently.
Run selection uses a persisted five-slot weighted schedule (three active, one
standby, one building) so sustained active ingress preserves reader freshness
without starving a shadow build or rollback projection across worker restarts.

Every incremental changing operation snapshots previous/current assignments in
`imap_thread_assignment_history`; a latest-operation guard makes incremental
rollback safe. Build snapshots are already isolated projections, so their
bounded operation summaries are retained without duplicating every assignment
as JSON history. Activation rollback swaps the pointer back only while the
standby run is still caught up. Both rollback paths pause automatic processing
until an operator completes and activates a clean rebuild. Old terminal
projection runs are pruned in bounded batches; operations, comparisons, and
incremental history intentionally survive message and projection retention.

Mirror writes take a shared lock on the small account thread-state row. Build,
activation, and rollback take it exclusively, so activation cannot certify
coverage across an in-flight metadata/body write. A database-owned trigger is
the rolling-deploy backstop: it advances a monotonic account evidence clock and
fans changed messages independently to the active, candidate, and rollback
runs even when the writing process predates the threading code. Deletes enqueue
one bounded closure seed per affected component plus its weak-subject bucket.

### Read contract

Canonical APIs expose `conversation_id` while retaining `provider_thread_id` as
provider metadata. Reads use only the active assignment view; an unassigned seed
falls back conservatively to the legacy one-hop behavior during rollout. A
legacy provider-thread selector remains available only with account scope.
Search partitions by `(account_id, conversation_id)` and then delivery key, so
neither provider-ID collisions across accounts nor mirrored copies collapse
unrelated mail.

## Consequences

- Thread membership is seed-independent, transitive, auditable, and rebuildable.
- Missing parents and out-of-order historical sync converge without special-case
  manual merges.
- The migration adds nullable evidence columns and new projection structures;
  it performs no mailbox-wide DML or index build on the existing message/body
  tables. Existing mirrors backfill through bounded shadow runs.
- Strict parsing and narrow fallback prefer false splits over dangerous false
  merges. Algorithm improvements require a version bump and deterministic rebuild.
- Soft-deleted rows remain graph evidence. Before hard retention deletes a row,
  the purge path queues every surviving conversation neighbor and weak-subject
  bucket across every live run; oversized fan-out is retained rather than
  knowingly leaving a stale projection.
- Comparison scans have a database statement-time budget, and activation
  certificates become invalid after any evidence or projection generation
  change.
- Work-item clustering, content similarity, CRM identity, and belief machinery
  remain outside the SupaMail core.

## Verification

- Pure algorithm tests cover transitive chains from every seed, missing and late
  parents, malformed/conflicting headers, cycles, provider hints, duplicate
  copies, forwards, automated mail, and subject reuse.
- Live PostgreSQL tests cover bounded multi-batch shadow activation, incremental
  orphan repair, late subject roots, weak-merge invalidation, row/evidence caps,
  complete MIME copy evidence, multi-version executor routing, persisted weighted
  active/candidate/standby fairness and missing-executor startup/direct-path guards,
  persisted comparison drift, an in-flight legacy-writer activation barrier,
  activation and incremental rollback, purge invalidation, run retention,
  active-view isolation, read dedupe, and mutation fan-out.
- A populated-upgrade harness loads 5,000 pre-0014 messages and parsed-only
  bodies, applies 0014 twice, and proves that the migration neither rewrites raw
  rows nor creates a partially active projection.
- The bundled hand-labeled corpus is a synthetic, publishable regression gate;
  it does not establish production quality by itself. A deployment replacing an
  existing active projection still requires a persisted shadow-run comparison
  at the current evidence revision, followed by review against private,
  representative mailbox disagreements before activation.
- Root typecheck/test/build and `pnpm test:db:live` are required.

## References

- RFC 5322 section 3.6.4 (Message-ID, In-Reply-To, References).
- RFC 5256 section 2.1 (REFERENCES threading algorithm and base subject).
- RFC 8474 (IMAP OBJECTID EMAILID/THREADID).
- RFC 9051 (mailbox/UID identity semantics).
- JWZ message threading algorithm.
- `apps/api/src/threading.ts`
- `apps/api/supabase/migrations/public/0014_conversation_threading.sql`
