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

When an installation deliberately discarded historical raw MIME, an exact
parsed-representation digest may provide the corroboration. It covers the parsed
body variants, MIME structure, full parsed headers, envelope, byte sizes, and
parser warnings, and is emitted only for complete, non-truncated bodies with a
sender and recipient. Any disagreement remains split.

Algorithm v2 treats raw-MIME, full parsed-representation, and transport-invariant
authored-representation digests as a set of evidence tokens instead of choosing
one tier and discarding the others. Physical rows with the same strict Message-ID
belong to one delivery component when any token is shared. The authored digest is
the conservative answer to a common provider mutation: an Inbox copy may add
`Received`, authentication, routing, and spam headers and change wire size while
the Sent copy retains the original bytes. It excludes those transport fields but
includes the original Message-ID and Date, envelope, stable MIME headers, every
parsed body variant, MIME structure, parser warnings, and the complete structured
evidence digest (including decoded attachment identities). This safely collapses
transport-mutated and raw/parsed-only mirrors while still splitting reused
Message-IDs whose authored representations differ. The v1 and v2 executors
remain registered for active and rollback projections.

Algorithm v3 retains those rules and adds an exact-metadata mirror fallback.
Same-Message-ID candidates collapse only when timestamp, byte size, normalized
subject, sender, and all recipient fields match exactly and the components occupy
distinct mailbox folders. A repeated candidate in one folder or more than one
authored digest vetoes the fallback. Raw/full-parsed digest disagreement is not
negative evidence because transport and storage representations can differ. A
metadata match queues eligible authored corroboration before a shadow run
becomes ready. This targets measured duplicate
`INBOX`/`INBOX.INBOX` rows without weakening the reused-ID fail-closed rule.

V3 also treats a directly prefixed forward as a new authored protocol
conversation. Inherited `References`, `In-Reply-To`, and provider-thread evidence
do not attach it to the original, while a later reply may attach to the forwarded
outer message. The original and forwarded branches may still share a future
broader application relationship; that relation is not protocol conversation truth.

V2 queues every eligible row only after the same strict Message-ID has produced
different delivery candidates. The next bounded preflight derives at most the
normal body-evidence batch under the same server deadline. The queue item survives
ordinary projection cleanup, and the authored-evidence trigger schedules
deterministic recomputation after repair. This avoids hashing every historical
body while resolving real collisions; any computed mismatch remains split.
If a queued body becomes truncated or otherwise incomplete before repair, its
special queue item is downgraded to ordinary recomputation instead of wedging the
run. Parsed/authored digests are derived projections too: body refetches and
provider corrections to their envelope inputs clear them at the database boundary,
then the evidence triggers recompute every state-referenced run. Stale exact-copy
evidence is therefore never retained after its source changes.

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
assignment write transaction normalizes the same relationship evidence into
`imap_thread_closure_edges`. Expansion uses one run-scoped indexed join for all
closure sizes while applying the same evidence predicates. This adds projection
storage and relationship-change write work, but removes repeated array and
predicate reconstruction from each closure read. The subject bucket and write
batch also have hard caps. If a previously accepted
weak subject bucket later grows beyond its cap, the worker first dissolves the
old weak edges in bounded components. Work is serialized per account, retries
are persisted before releasing the account lock, and processing is idempotent
per run.

An aggregate closure/evidence-limit failure, PostgreSQL statement timeout, or
repository-owned aggregate metadata-protection deadline in page-scaled
closure/persistence work reduces the run's durable page size before retry.
Arbitrary adapter failures remain non-adaptive. Dirty-queue rows remain intact
with their original ordering and a queue-local delay; the run itself stays
eligible so later ready rows can advance.
Repeated subdivision reaches one seed, whose own retry is then delayed without
blocking later rows and becomes operator-alertable after ten attempts. A
one-seed failure during the keyset build scan uses run-level backoff because
queue delay does not control that scan. Fixed-cost database work, other database
errors, and executor failures also retain run-level exponential backoff. A run
under that backoff is excluded from the weighted active/candidate/standby choice
so another eligible projection can use the account's threading pass.
Optional stage timings expose only fixed stage names, outcome, elapsed time,
counts, and iteration numbers; they never include account, message, or mailbox
identifiers or email metadata.

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
The default activation policy remains explicit. A deployment whose downstream
readers require conversations immediately may set
`THREADING_AUTO_ACTIVATE_INITIAL=true`. That option applies only when the ready
run is `mode='initial'` and there is no baseline projection: the worker calls the
same atomic activation path, including physical-row coverage, evidence-clock,
and empty-queue checks. Run selection keeps that ready initial projection
eligible until activation commits, so a crash or transient account-lock race
cannot strand the first projection. It does not auto-activate rebuilds or
algorithm upgrades; replacement activation continues to require a reviewed,
passing comparison certificate.
Run selection uses a persisted five-slot weighted schedule (three active, one
standby, one building) so sustained active ingress preserves reader freshness
without starving a shadow build or rollback projection across worker restarts.
The scan cursor is the immutable physical-message UUID, not mutable mailbox
coordinates. Catch-up also anti-joins the physical mirror against assignments
and repairs missing rows in bounded batches, so a run cannot become `ready`
merely because its queues happen to be empty. Singleton subject buckets are
retired in bounded batches, and the ordinary worker advances at most ten
independent steps per account under a 20-second threading-lane budget.

Only the latest material change to the active run keeps previous/current
assignments in `imap_thread_assignment_history`. The next material active
change replaces that history in the same transaction. Candidate and standby
runs keep compact operation summaries but no per-message history because
incremental rollback cannot target them. Activation and successful rollback
clear obsolete assignment history; compact operations and comparison
certificates remain as the durable audit record. Activation rollback swaps the
pointer back only while the standby run is still caught up. Both rollback paths
pause automatic processing until an operator completes and activates a clean
rebuild. Old terminal projection runs are pruned in bounded batches.

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
- Bounded rebuilds persist each physical row's bounded, namespaced delivery
  fingerprint hashes and iteratively close over their indexed overlap. This is execution
  completeness, not a new threading heuristic: it makes a paginated build agree
  with the same algorithm run over the full account, including exact-metadata
  mirror candidates that cross a page boundary.
- Soft-deleted rows remain graph evidence. Before hard retention deletes a row,
  the purge path queues every surviving conversation neighbor and weak-subject
  bucket across every live run; oversized fan-out is retained rather than
  knowingly leaving a stale projection.
- Comparison scans have a database statement-time budget, and activation
  certificates become invalid after any evidence or projection generation
  change.
- First-run auto-activation is deployment opt-in and deliberately narrower than
  general shadow activation. Consumers can avoid an indefinite no-active-run
  state without weakening reviewed replacement rollouts.
- Application-specific clustering, identity, and relationship machinery
  remain outside the SupaMail core.

## Verification

- Pure algorithm tests cover transitive chains from every seed, missing and late
  parents, malformed/conflicting headers, cycles, provider hints, duplicate
  copies, forwards, automated mail, subject reuse, and the authored-conflict and
  same-folder vetoes for exact-metadata evidence.
- Live PostgreSQL tests cover bounded multi-batch shadow activation, incremental
  orphan repair, late subject roots, weak-merge invalidation, row/evidence caps,
  complete MIME copy evidence, authored corroboration that reverses a provisional
  metadata merge, forward boundaries with replies, overlapping delivery
  fingerprints across a one-message page boundary, retained v1/v2 executor routing, persisted weighted
  active/candidate/standby fairness and missing-executor startup/direct-path guards,
  statement-timeout and metadata-protection-deadline subdivision,
  irreducible-item isolation and alerting,
  persisted comparison drift, an in-flight legacy-writer activation barrier,
  activation and incremental rollback, purge invalidation, run retention,
  active-view isolation, read dedupe, and mutation fan-out.
- Live PostgreSQL coverage proves the explicit first-run option activates only
  a complete initial projection through the ordinary activation transaction.
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
- `apps/api/supabase/migrations/public/0020_threading_fingerprint_closure.sql`
- `apps/api/supabase/migrations/public/0026_threading_closure_edges.sql`
