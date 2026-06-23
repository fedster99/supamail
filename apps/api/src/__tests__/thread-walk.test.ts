import { describe, expect, it } from "vitest";
import {
  normalizeIdToken,
  threadMembershipClause,
  threadSeedKeys,
  type ThreadSeedRow
} from "../thread-walk.js";

/**
 * Focused coverage for the ONE shared thread-membership walk (CC-3, ADR 0016).
 * `read_thread` (read surface) and `resolveThreadTargets` (write fan-out) both
 * source their normalization + WHERE predicate + ORDER here, so they agree on
 * "what is in a thread" by construction. The live-DB row equivalence is exercised
 * by read-thread.live-db.test.ts (including the header-only / NULL
 * provider_thread_id case); here we pin the seed-key normalization (the real
 * generic-IMAP bugs: angle-bracketed In-Reply-To, NULL provider_thread_id) and the
 * exact SQL fragment both callers slot in.
 */

function seed(overrides: Partial<ThreadSeedRow>): ThreadSeedRow {
  return {
    id: "seed-id",
    provider_thread_id: null,
    rfc_message_id: null,
    message_id_normalized: null,
    in_reply_to: null,
    references_header: null,
    account_id: "acc-1",
    ...overrides
  };
}

describe("normalizeIdToken", () => {
  it("strips surrounding angle brackets, trims, lowercases", () => {
    expect(normalizeIdToken("  <Root@ACME.com> ")).toBe("root@acme.com");
    expect(normalizeIdToken("<<weird>>")).toBe("weird");
    expect(normalizeIdToken("plain@x")).toBe("plain@x");
  });

  it("matches the SQL lower(trim(both '<>' from ...)) shape on an angle-bracketed In-Reply-To", () => {
    // The same normalization the predicate applies to in_reply_to column values.
    expect(normalizeIdToken("<R1@x>")).toBe("r1@x");
  });
});

describe("threadSeedKeys (generic-IMAP, header-only linkage)", () => {
  it("builds the distinct normalized key set from references + in_reply_to + ids", () => {
    const keys = threadSeedKeys(
      seed({
        // NULL provider_thread_id (generic IMAP) — linkage is header-only.
        provider_thread_id: null,
        rfc_message_id: "<r1@x>",
        message_id_normalized: "r1@x",
        in_reply_to: "<r0@x>",
        references_header: "<r0@x> <R1@x>"
      })
    );
    // De-duplicated + normalized: r0@x (from references + in_reply_to), r1@x (from
    // references + rfc_message_id + message_id_normalized, all collapsing to one).
    expect([...keys].sort()).toEqual(["r0@x", "r1@x"]);
  });

  it("splits whitespace-separated references and drops empty tokens", () => {
    const keys = threadSeedKeys(seed({ references_header: "  <a@x>   <b@x> " }));
    expect([...keys].sort()).toEqual(["a@x", "b@x"]);
  });

  it("returns an empty set when the seed has no threading headers", () => {
    expect(threadSeedKeys(seed({}))).toEqual([]);
  });
});

describe("threadMembershipClause", () => {
  it("emits the ADR-0016 predicate + oldest-first ORDER with the read alias (m)", () => {
    const clause = threadMembershipClause("m");
    expect(clause).toContain("m.account_id = $1");
    expect(clause).toContain("m.deleted_in_provider = false");
    expect(clause).toContain("($2::text IS NOT NULL AND m.provider_thread_id = $2)");
    expect(clause).toContain("OR m.id = $3");
    expect(clause).toContain("OR m.message_id_normalized = ANY($4::text[])");
    expect(clause).toContain("OR lower(trim(both '<>' from m.in_reply_to)) = ANY($4::text[])");
    expect(clause).toContain("ORDER BY m.internal_date ASC, m.id ASC");
  });

  it("emits the SAME predicate unaliased for the write fan-out", () => {
    const clause = threadMembershipClause("");
    expect(clause).toContain("account_id = $1");
    expect(clause).toContain("deleted_in_provider = false");
    expect(clause).toContain("($2::text IS NOT NULL AND provider_thread_id = $2)");
    expect(clause).toContain("OR id = $3");
    expect(clause).toContain("OR message_id_normalized = ANY($4::text[])");
    expect(clause).toContain("OR lower(trim(both '<>' from in_reply_to)) = ANY($4::text[])");
    expect(clause).toContain("ORDER BY internal_date ASC, id ASC");
    // No alias leaked in.
    expect(clause).not.toContain("m.");
  });
});
