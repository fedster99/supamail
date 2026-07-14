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
  it("extracts a strict bracketed token without changing case", () => {
    expect(normalizeIdToken("  <Root@ACME.com> ")).toBe("Root@ACME.com");
    expect(normalizeIdToken("<<weird>>")).toBe("");
    expect(normalizeIdToken("plain@x")).toBe("");
  });

  it("extracts the token used by the exact bracketed In-Reply-To SQL comparison", () => {
    expect(normalizeIdToken("<R1@x>")).toBe("R1@x");
  });
});

describe("threadSeedKeys (generic-IMAP, header-only linkage)", () => {
  it("builds the distinct strict key set from References, In-Reply-To, and Message-ID", () => {
    const keys = threadSeedKeys(
      seed({
        // NULL provider_thread_id (generic IMAP) — linkage is header-only.
        provider_thread_id: null,
        rfc_message_id: "<r1@x>",
        message_id_normalized: "r1@x",
        in_reply_to: "<r0@x>",
        references_header: "<r0@x> <r1@x>"
      })
    );
    // De-duplicated without case folding: r0@x (References + In-Reply-To), r1@x
    // (References + RFC Message-ID). The lowercased compatibility cache is ignored.
    expect([...keys].sort()).toEqual(["r0@x", "r1@x"]);
  });

  it("splits whitespace-separated references and drops empty tokens", () => {
    const keys = threadSeedKeys(seed({ references_header: "  <a@x>   <b@x> " }));
    expect([...keys].sort()).toEqual(["a@x", "b@x"]);
  });

  it("returns an empty set when the seed has no threading headers", () => {
    expect(threadSeedKeys(seed({}))).toEqual([]);
  });

  it("preserves case-sensitive local parts and ignores the lowercased legacy cache", () => {
    expect(threadSeedKeys(seed({
      rfc_message_id: "<Case@x>",
      references_header: "<case@x>",
      message_id_normalized: "case@x"
    }))).toEqual(["case@x", "Case@x"]);
  });

  it("does not repair bare or malformed IDs into graph keys", () => {
    expect(threadSeedKeys(seed({
      rfc_message_id: "Case@x",
      in_reply_to: "root @ x",
      references_header: "<also @ malformed>"
    }))).toEqual([]);
  });
});

describe("threadMembershipClause", () => {
  it("emits the ADR-0016 predicate + oldest-first ORDER with the read alias (m)", () => {
    const clause = threadMembershipClause("m");
    expect(clause).toContain("m.account_id = $1");
    expect(clause).toContain("m.deleted_in_provider = false");
    expect(clause).toContain("($2::text IS NOT NULL AND m.provider_thread_id = $2)");
    expect(clause).toContain("OR m.id = $3");
    expect(clause).toContain("OR btrim(m.rfc_message_id) IN");
    expect(clause).toContain("OR btrim(m.in_reply_to) IN");
    expect(clause).not.toContain("message_id_normalized");
    expect(clause).not.toContain("lower(");
    expect(clause).toContain("ORDER BY m.internal_date ASC, m.id ASC");
  });

  it("emits the SAME predicate unaliased for the write fan-out", () => {
    const clause = threadMembershipClause("");
    expect(clause).toContain("account_id = $1");
    expect(clause).toContain("deleted_in_provider = false");
    expect(clause).toContain("($2::text IS NOT NULL AND provider_thread_id = $2)");
    expect(clause).toContain("OR id = $3");
    expect(clause).toContain("OR btrim(rfc_message_id) IN");
    expect(clause).toContain("OR btrim(in_reply_to) IN");
    expect(clause).not.toContain("message_id_normalized");
    expect(clause).not.toContain("lower(");
    expect(clause).toContain("ORDER BY internal_date ASC, id ASC");
    // No alias leaked in.
    expect(clause).not.toContain("m.");
  });
});
