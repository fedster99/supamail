# Bounded flag verification experiment

## Integrated candidate

The candidate now persists progress on the existing folder row and resumes
bounded flag turns through the existing worker loop. It replaces the routine
no-MODSEQ seven-day approximation with full-live-window coverage. No separate
queue, pool, service, timer, or resource increase is introduced in public core.
Explicit live flag proofs and CONDSTORE/QRESYNC remain immediate; live metadata
alone cannot mark a background sweep complete. No merge or deployment occurred.

Regression tests cover restart, a new arrival during a sweep, a live pass during
partial progress, account/UIDVALIDITY fencing, folder fairness, missing provider
UIDs, and a real rejected checkpoint write after flags committed. The last case
replays idempotently after the existing account backoff. Missing UIDs go through
normal reconciliation rather than a guessed cursor or a tight retry loop.

`--engine` runs the actual engine, account lock, repository and durable cursor
against disposable Postgres. It rebuilds the engine between turns. IMAP remains
simulated, and no mixed user/body/search workload or CPU/memory cap applies.

| Rows | Phase | Exact | Turns | Total | Turn p95 | Turn p99 | Worst |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | Changed | 1,000 | 20 | 1.057 s | 89.4 ms | 89.6 ms | 89.6 ms |
| 1,000 | Unchanged | 1,000 | 20 | 0.642 s | 40.1 ms | 50.0 ms | 50.0 ms |
| 10,000 | Changed | 10,000 | 200 | 9.649 s | 63.6 ms | 82.6 ms | 115.7 ms |
| 10,000 | Unchanged | 10,000 | 200 | 6.219 s | 43.0 ms | 51.2 ms | 59.5 ms |

Two physical pool clients; zero sampled waiters, wrong-scope updates or replay
changes. These turn durations are not mailbox-convergence or real IMAP timings.
The earlier page-only DB probe was cheaper (about 4.0/1.3 s for 10,000 changed/
unchanged rows), because it omitted durable checkpoints and per-turn account
ownership. This is a correctness/fairness improvement, **not a demonstrated
total-throughput gain**. Connection setup, provider throttling, concurrent load,
and sparse historical distributions remain required qualification measurements.

```bash
pnpm --filter @supamail/api exec tsx scripts/benchmark-flag-verification.ts --engine
pnpm test:db:live
```

Integrated verification: 914 default API tests passed (264 DB-gated tests
skipped there); all 264 live-DB tests and 120 spec-conformance assertions
passed separately, including migration reapplication. Root typecheck/build
passed; unchanged web results used the workspace cache. No real-provider or
mixed-load capacity claim follows from these focused tests.

## Original test-only experiment (`0beba0b3`)

Status: retain the page primitive as an experiment; reject one-page-per-safety-cycle scheduling.
No production scan policy, scheduler, schema, queue, timeout, or limit changed.
The prototype is under test helpers and is not imported by runtime code.

## Question and baseline

Can a no-MODSEQ mailbox verify flags across its 90-day mirror without doing
whole-folder work in one turn?

Baseline core: `0749022f2bc8bb8c96208b7d29b3bfeaee6aa543`.
The ordinary due flag scan checks 7 days. The existing forced scan checks the
full active window, but first materializes its provider UID set and then fetches
flags in batches. A full scan's total row work grows with folder size.

This experiment runs that actual `MirrorEngine.syncFolder` path against an
in-memory provider and repository. Every fixture message starts with a stale
flag; message ages span 0.5–88.5 days. No notification or MODSEQ exposes the change.
All arms use the unchanged default batch size of 50.

The candidate reads a keyset page of known live mirror UIDs for an exact
Mailbox Account / folder / UIDVALIDITY, then uses the existing strict flag FETCH
helper. One turn reads at most 51 UIDs (one look-ahead), fetches at most 50
flags, and commits one logical flag batch. A frozen upper UID prevents ongoing
new mail from indefinitely extending a sweep.

## Repeatable work-count results

Both size orders (1,000 → 10,000 → 50,000 and reverse) gave identical work counts
and correctness. These are messages per folder, NOT Mailbox Account counts.

| Messages | Existing 7-day scan: exact / total | Existing full scan: exact / total | Paged: exact / total | Paged turns |
| --- | --- | --- | --- | ---: |
| 1,000 | 84 / 1,000 | 1,000 / 1,000 | 1,000 / 1,000 | 20 |
| 10,000 | 791 / 10,000 | 10,000 / 10,000 | 10,000 / 10,000 | 200 |
| 50,000 | 3,934 / 50,000 | 50,000 / 50,000 | 50,000 / 50,000 | 1,000 |

For 10,000 messages:

| Work | Existing forced full scan | Paged full coverage |
| --- | ---: | ---: |
| Flag rows fetched / written | 10,000 | 10,000 |
| Maximum flag rows per turn | 10,000 | 50 |
| Logical flag write batches | 200 | 200 |
| Full-window UID discovery rows | 10,000 | 0 |
| Mirror page reads | 0 | 200 |
| Maximum returned mirror page | N/A | 51 |

The candidate removes provider-wide UID discovery, but adds mirror page reads
and checkpoint persistence. It bounds each turn; it does not eliminate the
need to inspect all flags. Wire roundtrips, provider latency, CPU/RSS under a
production workload, and total end-to-end convergence were NOT measured.
In-memory harness duration is not a speed result.

## Real Postgres check

The optional `--db` mode starts disposable PostgreSQL 16, applies the actual
public migrations, seeds synthetic mirror rows, runs the real indexed page
query, and calls the actual `MirrorRepository.applyFlagScan`. IMAP remains
simulated. No new index, table, or migration is added to the product.

| Messages | Provider flags | Exact after scan | Local DB-path wall time | Read p95 | Flag persistence p95 |
| --- | --- | --- | ---: | ---: | ---: |
| 1,000 | All changed | 1,000 / 1,000 | 0.437 s | 2.282 ms | 28.998 ms |
| 1,000 | Unchanged | 1,000 / 1,000 | 0.140 s | 1.890 ms | 6.921 ms |
| 10,000 | All changed | 10,000 / 10,000 | 3.969 s | 2.652 ms | 26.310 ms |
| 10,000 | Unchanged | 10,000 / 10,000 | 1.336 s | 1.806 ms | 8.471 ms |

At 10,000 messages, page reads took 261 ms total and flag persistence took
3,681 ms when all flags changed; unchanged flags took 208 ms and 1,106 ms.
One physical pool client served the serial probe; sampled pool waiters stayed
at zero. Controls for another Mailbox Account, folder, and UIDVALIDITY had zero
updates. Replaying an acknowledged page reported zero additional changes.

`EXPLAIN (ANALYZE, BUFFERS)` used the existing
`imap_messages_folder_uid_idx` and returned 51 rows, with no rejected rows for
these dense fixtures. This does not prove a hard bound on scanned rows when
expired/historical rows dominate; qualify that distribution before integration.
An initial probe sorted the cast text UID alias rather than the numeric
column. The strict page-order assertion rejected it before any flag write.
The query now explicitly orders by `imap_messages.uid`.

These measurements exclude provider latency, concurrent users, encryption
adapters, checkpoint persistence, and downstream body/search/MCP activity.
They establish that the indexed read is small in this local fixture, not a
production capacity or speed improvement. Query-plan inspection follows
[Supabase's query optimization guidance](https://supabase.com/docs/guides/database/query-optimization).

## Scheduling result

One 50-message page per five-minute cycle would require up to:

- 1,000 messages: 100 minutes.
- 10,000 messages: 1,000 minutes (16.7 hours).
- 50,000 messages: 5,000 minutes (83.3 hours).

These are arithmetic coverage budgets, not observed provider latencies, and
assume every cycle gets a page slot. Contention or failures can make them worse.
Waiting the normal six-hour non-priority flag interval after each page would
be worse still. Do not implement that scheduling policy.

## Regression coverage and limits

Seventeen focused assertions cover fixed page bounds, full frozen-set coverage,
new arrivals, sparse/deleted mirror rows, wrong Mailbox Account/folder,
UIDVALIDITY reset, malformed pages, missing provider flags, failed persistence,
and safe replay after lost checkpoint acknowledgement.

No cursor persistence or scheduler integration ships with this prototype.
The default work-count adapter is simulated; `--db` tests the SQL query and
real flag writes with scope controls, not tenant authorization/RLS. The caller must
hold the existing account/mailbox lock, enforce the existing deadline, and
persist progress only after acknowledged flag writes. Replay relies on the
existing idempotent flag diff. A UID disappearing between selection and FETCH
fails closed; existing authoritative reconciliation must repair that state.
These tests do not prove full tenant authorization, concurrent DB isolation, body,
search, MCP, provider quotas, or restart behavior of an integrated worker.

## Decision

Keep the bounded-page mechanism for the next experiment. Keep the production
flag policy unchanged until the integrated cost is measured.

The next candidate should persist a folder-scoped sweep checkpoint, continue
pages fairly through the existing bounded work lane, and schedule the next
ordinary scan only after the sweep completes. Do not create a separate queue
or wait five minutes between pending pages. Preserve live-work priority and
existing account/provider permits. Test the actual indexed mirror selection,
checkpoint/restart semantics, and provider cost before choosing a freshness
target. A provider without MODSEQ cannot offer changed-flags-only recovery from
unchanged counters; complete verification has a cost proportional to coverage.

## Reproduce

Use Node 24 and the locked pnpm dependencies:

```sh
pnpm --filter @supamail/api exec vitest run src/__tests__/flag-verification-prototype.test.ts
pnpm --filter @supamail/api exec tsx scripts/benchmark-flag-verification.ts
pnpm --filter @supamail/api exec tsx scripts/benchmark-flag-verification.ts 50000 10000 1000
pnpm --filter @supamail/api exec tsx scripts/benchmark-flag-verification.ts --db
```

The benchmark accepts folder message counts up to 100,000. It prints explicit
work counters and assertions, not a production performance score.

Verification: 17 focused tests passed; API typecheck, default tests (913 passed,
259 DB-gated tests skipped), and build passed. Unchanged web results reused the
workspace build cache. The focused disposable database probe is not the full
`test:db:live` gate; no runtime code or schema was changed in this experiment.
