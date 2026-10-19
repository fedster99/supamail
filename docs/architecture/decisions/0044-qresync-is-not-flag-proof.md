# ADR 0044: A QRESYNC replay is not proof of flags

Status: Accepted

## Problem

Since the QRESYNC replay (supamail#138), a complete replay counted as the
folder's flag scan and advanced the flag-only CONDSTORE cursor. On a modseq
server nothing else read flags: the full-window scan ran only without a modseq,
and an unchanged CONDSTORE cursor skipped the windowed scan.

Purelymail sends a complete replay without the flag changes. A probe on
2026-10-18 (Cloud `scripts/probe-modseq-flag-replay.mjs`) showed, for each of
+/-`\Flagged` and +/-`\Seen` from another session: the message MODSEQ and
HIGHESTMODSEQ rise, `SELECT ... (QRESYNC (...))` returns no FETCH, and
`UID FETCH 1:* (FLAGS) (CHANGEDSINCE n)` returns exactly the changed message.
So a flag changed in webmail or on a phone never reached the mirror.

## Decision

- A replay applies its VANISHED UIDs and any flags it names, and advances only
  the QRESYNC cursor. It never counts as a flag read.
- Flags come from CONDSTORE. When the selected HIGHESTMODSEQ is past the flag
  cursor, the pass reads `CHANGEDSINCE` at once. It reads only changed messages,
  so it needs no flag-scan slot; only a window scan spends one. Only a flag read
  advances the flag cursor.
- Each scheduled exact reconcile also scans flags over the whole live window on
  every server, inside the reconcile slot, so `RECONCILE_INTERVAL_MS` bounds flag
  staleness even where a server's `CHANGEDSINCE` is wrong. It runs after the
  `CHANGEDSINCE` read, never instead of it: the window scan misses older mail.
  It never blocks its reconcile: it reads newest mail first, starts no batch
  after half of `FLAG_SCAN_TOTAL_TIMEOUT_MS`, and records an early stop as
  `FLAG_BACKSTOP_INCOMPLETE`. Establishing a new flag cursor still scans the
  whole window or fails.
- An unchanged modseq proves no flag changed, so it counts as a flag read.
- The Sent-only lane (ADR 0023) still reads no flags.
- A shared IDLE session ignores `VANISHED (EARLIER)`: it only answers the
  session's own QRESYNC SELECT or `CHANGEDSINCE` FETCH (RFC 7162 section 3.2.10),
  so it is never a new change.

## Consequences

- A flag changed outside SupaMail arrives in the next pass on that folder, with
  one extra command, and within one reconcile interval in the worst case.
- One full-window flag read per folder per reconcile interval: a 9,000-message
  window is about 180 FETCH batches of 50. A window too large to read in half
  the flag deadline converges newest first and logs `FLAG_BACKSTOP_INCOMPLETE`;
  older mail there relies on `CHANGEDSINCE`.
- No provider switch: every server takes the same path.
