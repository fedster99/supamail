import { describe, expect, it } from "vitest";
import {
  THREADING_ALGORITHM_VERSION,
  canonicalizeMessageId,
  computeThreadAssignments,
  computeThreadAssignmentsV1,
  computeThreadAssignmentsV2,
  extractMessageIdTokens,
  type ThreadingAssignment,
  type ThreadingMessageInput
} from "../threading.js";

function message(id: string, overrides: Partial<ThreadingMessageInput> = {}): ThreadingMessageInput {
  return {
    id,
    account_id: "account-a",
    folder_path: "INBOX",
    uidvalidity: "1",
    uid: id.replace(/\D/g, "") || id,
    internal_date: "2026-01-01T12:00:00.000Z",
    size_bytes: 1_024,
    subject: "Project Atlas",
    from_email: "alice@example.test",
    to_emails: ["bob@example.test"],
    ...overrides
  };
}

function byId(assignments: ThreadingAssignment[], id: string): ThreadingAssignment {
  const assignment = assignments.find((candidate) => candidate.physical_message_id === id);
  if (!assignment) throw new Error(`missing assignment ${id}`);
  return assignment;
}

describe("RFC Message-ID parsing", () => {
  it("rejects internal CFWS instead of concatenating it into another Message-ID", () => {
    const assignments = computeThreadAssignments([
      message("cfws-root", {
        rfc_message_id: "<root@example.test>",
        subject: "Unrelated root"
      }),
      message("cfws-child", {
        rfc_message_id: "<child@example.test>",
        in_reply_to: "<root (malformed) @ example.test>",
        subject: "Another subject"
      })
    ]);

    expect(canonicalizeMessageId("root @ example.test")).toBeNull();
    expect(extractMessageIdTokens("<root (malformed) @ example.test>")).toEqual([]);
    expect(byId(assignments, "cfws-child").conversation_id)
      .not.toBe(byId(assignments, "cfws-root").conversation_id);
    expect(byId(assignments, "cfws-child").evidence.parse_warnings)
      .toContain("malformed_in_reply_to_ignored");
  });

  it("extracts folded and adjacent tokens, canonicalizes quoted dot-atoms, and ignores malformed fragments", () => {
    const tokens = extractMessageIdTokens(
      '<"Alpha"@Example.TEST>\r\n\t<Beta@x><broken> text <Gamma (old comment) @ y> <<Recovered@z> <unclosed@z'
    );

    expect(tokens).toEqual(["Alpha@Example.TEST", "Beta@x", "Recovered@z"]);
    expect(canonicalizeMessageId('"Alpha"@Example.TEST')).toBe("Alpha@Example.TEST");
  });

  it("ignores Message-ID-looking text inside RFC comments", () => {
    const header = "(former parent <wrong@x>) <actual@x>";
    expect(extractMessageIdTokens(header)).toEqual(["actual@x"]);

    const assignments = computeThreadAssignments([
      message("comment-wrong", { rfc_message_id: "<wrong@x>" }),
      message("comment-actual", { rfc_message_id: "<actual@x>" }),
      message("comment-child", {
        rfc_message_id: "<comment-child@x>",
        references_header: header
      })
    ]);

    expect(byId(assignments, "comment-child").conversation_id)
      .toBe(byId(assignments, "comment-actual").conversation_id);
    expect(byId(assignments, "comment-child").conversation_id)
      .not.toBe(byId(assignments, "comment-wrong").conversation_id);
  });

  it("preserves case because RFC Message-ID comparison is case-sensitive", () => {
    expect(extractMessageIdTokens("<Root@x> <root@x>")).toEqual(["Root@x", "root@x"]);
  });

  it("preserves legal domain-literal data instead of treating it as CFWS", () => {
    expect(canonicalizeMessageId("id@[a(foo)@b]")).toBe("id@[a(foo)@b]");
    expect(canonicalizeMessageId("id@[a(foo)@b]")).not.toBe(canonicalizeMessageId("id@[a@b]"));
    expect(extractMessageIdTokens("<id@[a(foo)@b]> <next@x>")).toEqual([
      "id@[a(foo)@b]",
      "next@x"
    ]);
  });

  it("rejects oversized hostile headers and blocks weak fallback after doing so", () => {
    const hostile = "<".repeat(300_000);
    expect(extractMessageIdTokens(hostile)).toEqual([]);

    const assignments = computeThreadAssignments([
      message("oversized-root", {
        rfc_message_id: "<oversized-root@x>",
        subject: "Capacity plan",
        from_email: "alice@example.test",
        to_emails: ["bob@example.test"],
        internal_date: "2026-01-01T10:00:00Z"
      }),
      message("oversized-reply", {
        rfc_message_id: "<oversized-reply@x>",
        references_header: hostile,
        subject: "Re: Capacity plan",
        from_email: "bob@example.test",
        to_emails: ["alice@example.test"],
        internal_date: "2026-01-02T10:00:00Z"
      })
    ]);

    expect(byId(assignments, "oversized-root").conversation_id)
      .not.toBe(byId(assignments, "oversized-reply").conversation_id);
    expect(byId(assignments, "oversized-reply").evidence.parse_warnings)
      .toContain("oversized_references_ignored");
  });

  it("retains the immediate-parent tail when a References chain exceeds its limit", () => {
    const references = Array.from({ length: 300 }, (_, index) => `<ref-${index}@x>`).join(" ");
    const assignment = byId(computeThreadAssignments([
      message("long-chain-reply", {
        rfc_message_id: "<long-chain-reply@x>",
        references_header: references
      })
    ]), "long-chain-reply");

    expect(assignment.reference_ids).toHaveLength(256);
    expect(assignment.reference_ids[0]).toBe("ref-44@x");
    expect(assignment.reference_ids.at(-1)).toBe("ref-299@x");
    expect(assignment.parent_reference).toBe("ref-299@x");
    expect(assignment.evidence.parse_warnings).toContain("references_truncated");
  });
});

describe("protocol conversation graph", () => {
  it("rejects conflicting explicit and JSON References instead of inventing a chain", () => {
    const assignments = computeThreadAssignments([
      message("source-root-a", {
        rfc_message_id: "<source-root-a@x>",
        subject: "Root A"
      }),
      message("source-root-b", {
        rfc_message_id: "<source-root-b@x>",
        subject: "Root B"
      }),
      message("source-conflict-child", {
        rfc_message_id: "<source-conflict-child@x>",
        references_header: "<source-root-a@x>",
        headers_json: { references: "<source-root-b@x>" },
        subject: "Child"
      })
    ]);

    const child = byId(assignments, "source-conflict-child");
    expect(child.reference_ids).toEqual([]);
    expect(child.parent_reference).toBeNull();
    expect(child.conversation_id).not.toBe(byId(assignments, "source-root-a").conversation_id);
    expect(child.conversation_id).not.toBe(byId(assignments, "source-root-b").conversation_id);
    expect(child.evidence.parse_warnings).toContain("conflicting_references_sources_ignored");
  });

  it("rejects conflicting repeated References fields instead of concatenating them into ancestry", () => {
    const assignments = computeThreadAssignments([
      message("repeated-root-a", { rfc_message_id: "<repeated-root-a@x>" }),
      message("repeated-root-b", { rfc_message_id: "<repeated-root-b@x>" }),
      message("repeated-references-child", {
        rfc_message_id: "<repeated-references-child@x>",
        references_header: ["<repeated-root-a@x>", "<repeated-root-b@x>"],
        subject: "Independent child"
      })
    ]);

    const child = byId(assignments, "repeated-references-child");
    expect(child.reference_ids).toEqual([]);
    expect(child.parent_reference).toBeNull();
    expect(child.conversation_id).not.toBe(byId(assignments, "repeated-root-a").conversation_id);
    expect(child.conversation_id).not.toBe(byId(assignments, "repeated-root-b").conversation_id);
    expect(child.evidence.parse_warnings).toContain("conflicting_references_sources_ignored");
  });

  it("keeps the more complete chain from suffix-compatible repeated References fields", () => {
    const assignments = computeThreadAssignments([
      message("repeated-compatible-root", { rfc_message_id: "<repeated-compatible-root@x>" }),
      message("repeated-compatible-parent", {
        rfc_message_id: "<repeated-compatible-parent@x>",
        references_header: "<repeated-compatible-root@x>"
      }),
      message("repeated-compatible-child", {
        rfc_message_id: "<repeated-compatible-child@x>",
        references_header: [
          "<repeated-compatible-parent@x>",
          "<repeated-compatible-root@x> <repeated-compatible-parent@x>"
        ]
      })
    ]);

    const child = byId(assignments, "repeated-compatible-child");
    expect(child.reference_ids).toEqual([
      "repeated-compatible-root@x",
      "repeated-compatible-parent@x"
    ]);
    expect(child.parent_delivery_key)
      .toBe(byId(assignments, "repeated-compatible-parent").delivery_key);
    expect(child.conversation_id)
      .toBe(byId(assignments, "repeated-compatible-root").conversation_id);
  });

  it("rejects conflicting explicit and JSON Message-ID sources instead of claiming either identity", () => {
    const assignments = computeThreadAssignments([
      message("message-id-source-conflict", {
        rfc_message_id: "<wrong-owner@x>",
        headers_json: { "message-id": "<actual-owner@x>" },
        subject: "Conflicted identity"
      }),
      message("wrong-owner-reply", {
        rfc_message_id: "<wrong-owner-reply@x>",
        in_reply_to: "<wrong-owner@x>",
        subject: "Different subject"
      })
    ]);

    const conflicted = byId(assignments, "message-id-source-conflict");
    expect(conflicted.strict_message_id).toBeNull();
    expect(conflicted.evidence.parse_warnings)
      .toContain("conflicting_message_id_sources_ignored");
    expect(conflicted.conversation_id)
      .not.toBe(byId(assignments, "wrong-owner-reply").conversation_id);
  });

  it("rejects conflicting explicit and JSON In-Reply-To instead of choosing one", () => {
    const assignments = computeThreadAssignments([
      message("irt-source-root-a", {
        rfc_message_id: "<irt-source-root-a@x>",
        subject: "Root A"
      }),
      message("irt-source-root-b", {
        rfc_message_id: "<irt-source-root-b@x>",
        subject: "Root B"
      }),
      message("irt-source-conflict-child", {
        rfc_message_id: "<irt-source-conflict-child@x>",
        in_reply_to: "<irt-source-root-a@x>",
        headers_json: { "in-reply-to": "<irt-source-root-b@x>" },
        subject: "Child"
      })
    ]);

    const child = byId(assignments, "irt-source-conflict-child");
    expect(child.reference_ids).toEqual([]);
    expect(child.parent_reference).toBeNull();
    expect(child.conversation_id).not.toBe(byId(assignments, "irt-source-root-a").conversation_id);
    expect(child.conversation_id).not.toBe(byId(assignments, "irt-source-root-b").conversation_id);
    expect(child.evidence.parse_warnings).toContain("conflicting_in_reply_to_sources_ignored");
  });

  it("uses the more complete References chain when header sources are suffix-compatible", () => {
    const assignments = computeThreadAssignments([
      message("compatible-root", { rfc_message_id: "<compatible-root@x>" }),
      message("compatible-parent", {
        rfc_message_id: "<compatible-parent@x>",
        references_header: "<compatible-root@x>"
      }),
      message("compatible-child", {
        rfc_message_id: "<compatible-child@x>",
        references_header: "<compatible-parent@x>",
        headers_json: {
          references: "<compatible-root@x> <compatible-parent@x>"
        }
      })
    ]);

    const child = byId(assignments, "compatible-child");
    expect(child.reference_ids).toEqual(["compatible-root@x", "compatible-parent@x"]);
    expect(child.parent_delivery_key).toBe(byId(assignments, "compatible-parent").delivery_key);
    expect(child.conversation_id).toBe(byId(assignments, "compatible-root").conversation_id);
  });

  it("builds a transitive conversation whose id is identical from every physical seed", () => {
    const assignments = computeThreadAssignments([
      message("root", {
        rfc_message_id: "<root@x>",
        internal_date: "2026-01-01T10:00:00Z"
      }),
      message("reply-1", {
        rfc_message_id: "<reply-1@x>",
        references_header: "<root@x>",
        internal_date: "2026-01-01T11:00:00Z"
      }),
      message("reply-2", {
        rfc_message_id: "<reply-2@x>",
        references_header: "<root@x><reply-1@x>",
        internal_date: "2026-01-01T12:00:00Z"
      }),
      message("reply-3", {
        rfc_message_id: "<reply-3@x>",
        in_reply_to: "<reply-2@x>",
        internal_date: "2026-01-01T13:00:00Z"
      })
    ]);

    expect(new Set(assignments.map((assignment) => assignment.conversation_id)).size).toBe(1);
    expect(assignments.every((assignment) => assignment.root_reference === "root@x")).toBe(true);
    expect(byId(assignments, "reply-1").parent_delivery_key).toBe(byId(assignments, "root").delivery_key);
    expect(byId(assignments, "reply-2").parent_delivery_key).toBe(byId(assignments, "reply-1").delivery_key);
    expect(byId(assignments, "reply-3").parent_delivery_key).toBe(byId(assignments, "reply-2").delivery_key);
    expect(byId(assignments, "reply-3").method).toBe("in_reply_to");
    expect(assignments.every((assignment) => assignment.provisional === false)).toBe(true);
  });

  it("uses References over a conflicting In-Reply-To and otherwise falls back to the first valid IRT", () => {
    const assignments = computeThreadAssignments([
      message("root-a", { rfc_message_id: "<a@x>" }),
      message("root-b", { rfc_message_id: "<b@x>" }),
      message("references-wins", {
        rfc_message_id: "<c@x>",
        references_header: "<a@x>",
        in_reply_to: "<b@x> <ignored@x>"
      }),
      message("irt-fallback", {
        rfc_message_id: "<d@x>",
        references_header: "malformed <not-an-id>",
        in_reply_to: "Alice <b@x> stray@example.test <ignored@x>"
      })
    ]);

    expect(byId(assignments, "references-wins").conversation_id).toBe(byId(assignments, "root-a").conversation_id);
    expect(byId(assignments, "references-wins").conversation_id).not.toBe(byId(assignments, "root-b").conversation_id);
    expect(byId(assignments, "references-wins").reference_ids).toEqual(["a@x"]);
    expect(byId(assignments, "references-wins").evidence.parse_warnings).toContain("conflicting_in_reply_to_ignored");

    expect(byId(assignments, "irt-fallback").conversation_id).toBe(byId(assignments, "root-b").conversation_id);
    expect(byId(assignments, "irt-fallback").reference_ids).toEqual(["b@x"]);
    expect(byId(assignments, "irt-fallback").method).toBe("in_reply_to");
  });

  it("keeps shared missing-parent placeholders and resolves a late parent without changing the conversation id", () => {
    const children = [
      message("child-1", {
        rfc_message_id: "<child-1@x>",
        in_reply_to: "<missing-root@x>",
        internal_date: "2026-01-02T10:00:00Z"
      }),
      message("child-2", {
        rfc_message_id: "<child-2@x>",
        references_header: "<missing-root@x> <child-1@x>",
        internal_date: "2026-01-02T11:00:00Z"
      })
    ];

    const before = computeThreadAssignments(children);
    expect(byId(before, "child-1").conversation_id).toBe(byId(before, "child-2").conversation_id);
    expect(byId(before, "child-1")).toMatchObject({
      root_reference: "missing-root@x",
      parent_reference: "missing-root@x",
      parent_delivery_key: null,
      confidence: "low",
      provisional: true
    });

    const after = computeThreadAssignments([
      message("late-root", {
        rfc_message_id: "<missing-root@x>",
        internal_date: "2026-01-01T10:00:00Z"
      }),
      ...children
    ]);
    expect(byId(after, "child-1").conversation_id).toBe(byId(before, "child-1").conversation_id);
    expect(byId(after, "child-1").parent_delivery_key).toBe(byId(after, "late-root").delivery_key);
    expect(byId(after, "child-1").provisional).toBe(false);
  });

  it("guards self/cyclic references without recursion or parent loops", () => {
    const assignments = computeThreadAssignments([
      message("cycle-a", {
        rfc_message_id: "<cycle-a@x>",
        in_reply_to: "<cycle-b@x>",
        internal_date: "2026-01-01T10:00:00Z"
      }),
      message("cycle-b", {
        rfc_message_id: "<cycle-b@x>",
        in_reply_to: "<cycle-a@x>",
        internal_date: "2026-01-01T11:00:00Z"
      }),
      message("self", {
        rfc_message_id: "<self@x>",
        references_header: "<self@x>"
      })
    ]);

    expect(byId(assignments, "cycle-a").conversation_id).toBe(byId(assignments, "cycle-b").conversation_id);
    expect([byId(assignments, "cycle-a"), byId(assignments, "cycle-b")]
      .filter((assignment) => assignment.parent_reference === null)).toHaveLength(1);
    expect(byId(assignments, "cycle-b").evidence.parse_warnings).toContain("reference_cycle_ignored");
    expect(byId(assignments, "self")).toMatchObject({
      parent_reference: null,
      reference_ids: [],
      method: "standalone"
    });
    expect(byId(assignments, "self").evidence.parse_warnings).toContain("self_reference_ignored");
  });

  it("retains an inferred parent when a stronger replacement would create a cycle", () => {
    const assignments = computeThreadAssignments([
      message("inferred-root", {
        rfc_message_id: "<inferred-root@x>",
        internal_date: "2026-01-01T08:00:00Z"
      }),
      message("cycle-child", {
        rfc_message_id: "<cycle-child@x>",
        references_header: "<inferred-root@x> <cycle-parent@x>",
        internal_date: "2026-01-01T09:00:00Z"
      }),
      message("cycle-parent", {
        rfc_message_id: "<cycle-parent@x>",
        references_header: "<cycle-child@x>",
        internal_date: "2026-01-01T10:00:00Z"
      })
    ]);

    expect(byId(assignments, "inferred-root").conversation_id)
      .toBe(byId(assignments, "cycle-parent").conversation_id);
    expect(byId(assignments, "cycle-parent").evidence.parse_warnings)
      .toContain("reference_cycle_ignored");
  });

  it("does not resolve case-only Message-ID variants", () => {
    const assignments = computeThreadAssignments([
      message("upper", { rfc_message_id: "<Root@x>" }),
      message("lower-reply", {
        rfc_message_id: "<reply@x>",
        in_reply_to: "<root@x>"
      })
    ]);

    expect(byId(assignments, "upper").conversation_id).not.toBe(byId(assignments, "lower-reply").conversation_id);
    expect(byId(assignments, "lower-reply")).toMatchObject({
      root_reference: "root@x",
      parent_delivery_key: null,
      provisional: true
    });
  });
});

describe("delivery copies and ambiguous duplicate Message-ID values", () => {
  it("collapses exact parsed copies when their Message-ID is malformed", () => {
    const assignments = computeThreadAssignments([
      message("malformed-copy-inbox", {
        folder_path: "INBOX",
        uid: 10,
        rfc_message_id: "<>",
        delivery_fingerprint: "same-complete-parsed-message"
      }),
      message("malformed-copy-mirror", {
        folder_path: "INBOX.INBOX",
        uid: 88,
        rfc_message_id: "<>",
        delivery_fingerprint: "same-complete-parsed-message"
      }),
      message("malformed-copy-other-account", {
        account_id: "account-b",
        rfc_message_id: "<>",
        delivery_fingerprint: "same-complete-parsed-message"
      })
    ]);

    const inbox = byId(assignments, "malformed-copy-inbox");
    const mirror = byId(assignments, "malformed-copy-mirror");
    expect(inbox.delivery_key).toBe(mirror.delivery_key);
    expect(inbox.conversation_id).toBe(mirror.conversation_id);
    expect(inbox.strict_message_id).toBeNull();
    expect(inbox.delivery_key)
      .not.toBe(byId(assignments, "malformed-copy-other-account").delivery_key);
    expect(inbox.evidence.collapsed_physical_ids).toEqual([
      "malformed-copy-inbox",
      "malformed-copy-mirror"
    ]);
  });

  it("does not let an exact fingerprint override conflicting valid Message-IDs", () => {
    const assignments = computeThreadAssignments([
      message("fingerprint-valid-a", {
        rfc_message_id: "<valid-a@x>",
        delivery_fingerprint: "same-complete-parsed-message"
      }),
      message("fingerprint-valid-b", {
        rfc_message_id: "<valid-b@x>",
        delivery_fingerprint: "same-complete-parsed-message"
      })
    ]);

    expect(byId(assignments, "fingerprint-valid-a").delivery_key)
      .not.toBe(byId(assignments, "fingerprint-valid-b").delivery_key);
    expect(byId(assignments, "fingerprint-valid-a").conversation_id)
      .not.toBe(byId(assignments, "fingerprint-valid-b").conversation_id);
  });

  it("keeps persisted derived keys bounded for hostile opaque provider values", () => {
    const opaque = Array.from({ length: 8_000 }, (_, index) => String.fromCharCode(33 + (index % 90))).join("");
    const assignment = byId(computeThreadAssignments([
      message("bounded-provider", {
        folder_path: opaque,
        provider_message_namespace: "custom",
        provider_message_id: opaque,
        provider_thread_namespace: "custom",
        provider_thread_id: opaque,
        subject: opaque
      })
    ]), "bounded-provider");

    expect(assignment.delivery_key.length).toBeLessThanOrEqual(96);
    expect(assignment.provider_thread_key?.length).toBeLessThanOrEqual(96);
    expect(assignment.subject_base).toBeNull();
  });

  it("collapses clear physical copies while retaining one output per mailbox row", () => {
    const assignments = computeThreadAssignments([
      message("inbox-copy", {
        folder_path: "INBOX",
        uid: 10,
        rfc_message_id: "<copied@x>",
        raw_mime_hash: "same-wire-bytes"
      }),
      message("archive-copy", {
        folder_path: "Archive",
        uid: 88,
        rfc_message_id: "<copied@x>",
        raw_mime_hash: "same-wire-bytes"
      })
    ]);

    expect(assignments).toHaveLength(2);
    expect(byId(assignments, "inbox-copy").delivery_key).toBe(byId(assignments, "archive-copy").delivery_key);
    expect(byId(assignments, "inbox-copy").conversation_id).toBe(byId(assignments, "archive-copy").conversation_id);
    expect(byId(assignments, "inbox-copy").evidence.collapsed_physical_ids).toEqual(["archive-copy", "inbox-copy"]);
    expect(byId(assignments, "inbox-copy")).toMatchObject({
      strict_message_id: "copied@x",
      subject_base: "project atlas",
      algorithm_version: THREADING_ALGORITHM_VERSION
    });
  });

  it("collapses exact metadata copies when content evidence is absent", () => {
    const inputs = [
      message("metadata-copy-inbox", {
        folder_path: "INBOX",
        uid: 10,
        rfc_message_id: "<metadata-copy@x>"
      }),
      message("metadata-copy-mirror", {
        folder_path: "INBOX.INBOX",
        uid: 88,
        rfc_message_id: "<metadata-copy@x>"
      })
    ];
    const assignments = computeThreadAssignments(inputs);

    expect(byId(assignments, "metadata-copy-inbox").delivery_key)
      .toBe(byId(assignments, "metadata-copy-mirror").delivery_key);
    expect(byId(assignments, "metadata-copy-inbox").evidence.collapsed_physical_ids)
      .toEqual(["metadata-copy-inbox", "metadata-copy-mirror"]);
    expect(byId(assignments, "metadata-copy-inbox").evidence.parse_warnings)
      .toContain("delivery_metadata_fingerprint_match");

    const retainedV2 = computeThreadAssignmentsV2(inputs);
    expect(byId(retainedV2, "metadata-copy-inbox").delivery_key)
      .not.toBe(byId(retainedV2, "metadata-copy-mirror").delivery_key);
  });

  it("normalizes every exact-metadata field before comparing mirrored copies", () => {
    const assignments = computeThreadAssignments([
      message("normalized-metadata-inbox", {
        folder_path: "INBOX",
        uid: 10,
        rfc_message_id: "<normalized-metadata@x>",
        internal_date: new Date("2026-01-01T12:00:00.000Z"),
        size_bytes: "001024",
        subject: "  Ｐroject\u00a0Atlas  ",
        from_email: " Alice@EXAMPLE.TEST ",
        to_emails: ["second@EXAMPLE.TEST", "first@example.test"],
        cc_emails: ["copy@EXAMPLE.TEST"]
      }),
      message("normalized-metadata-mirror", {
        folder_path: "INBOX.INBOX",
        uid: 88,
        rfc_message_id: "<normalized-metadata@x>",
        internal_date: "2026-01-01T12:00:00.000Z",
        size_bytes: 1_024,
        subject: "Project Atlas",
        from_email: "Alice@example.test",
        to_emails: ["first@example.test", "second@example.test"],
        cc_emails: ["copy@example.test"]
      })
    ]);

    expect(byId(assignments, "normalized-metadata-inbox").delivery_key)
      .toBe(byId(assignments, "normalized-metadata-mirror").delivery_key);
  });

  it.each([
    ["Message-ID", { rfc_message_id: null }],
    ["timestamp", { internal_date: "not-a-date" }],
    ["size", { size_bytes: -1 }],
    ["subject", { subject: "   " }],
    ["sender", { from_email: "   " }],
    ["recipient", { to_emails: [], cc_emails: [], bcc_emails: [] }]
  ] satisfies Array<[string, Partial<ThreadingMessageInput>]>) (
    "fails closed when exact metadata is missing a required %s",
    (_field, missing) => {
      const assignments = computeThreadAssignments([
        message("incomplete-metadata-inbox", {
          folder_path: "INBOX",
          rfc_message_id: "<incomplete-metadata@x>",
          ...missing
        }),
        message("incomplete-metadata-mirror", {
          folder_path: "INBOX.INBOX",
          rfc_message_id: "<incomplete-metadata@x>",
          ...missing
        })
      ]);

      expect(byId(assignments, "incomplete-metadata-inbox").delivery_key)
        .not.toBe(byId(assignments, "incomplete-metadata-mirror").delivery_key);
    }
  );

  it("lets conflicting authored evidence veto an exact metadata match", () => {
    const assignments = computeThreadAssignments([
      message("metadata-collision-a", {
        folder_path: "INBOX",
        uid: 10,
        rfc_message_id: "<metadata-collision@x>",
        authored_delivery_fingerprint: "authored-content-a"
      }),
      message("metadata-collision-b", {
        folder_path: "INBOX.INBOX",
        uid: 88,
        rfc_message_id: "<metadata-collision@x>",
        authored_delivery_fingerprint: "authored-content-b"
      })
    ]);

    expect(byId(assignments, "metadata-collision-a").delivery_key)
      .not.toBe(byId(assignments, "metadata-collision-b").delivery_key);
    expect(byId(assignments, "metadata-collision-a").evidence.parse_warnings)
      .toContain("delivery_metadata_collision_authored_conflict");
  });

  it("does not let metadata choose one side of an inherited authored conflict", () => {
    const assignments = computeThreadAssignments([
      message("authored-side-a", {
        folder_path: "INBOX",
        rfc_message_id: "<inherited-authored-conflict@x>",
        raw_mime_hash: "shared-with-bridge",
        authored_delivery_fingerprint: "authored-a"
      }),
      message("authored-side-b", {
        folder_path: "Archive",
        rfc_message_id: "<inherited-authored-conflict@x>",
        subject: "Different metadata",
        delivery_fingerprint: "also-shared-with-bridge",
        authored_delivery_fingerprint: "authored-b"
      }),
      message("digest-less-bridge", {
        folder_path: "INBOX.INBOX",
        rfc_message_id: "<inherited-authored-conflict@x>",
        raw_mime_hash: "shared-with-bridge",
        delivery_fingerprint: "also-shared-with-bridge"
      })
    ]);

    const keys = ["authored-side-a", "authored-side-b", "digest-less-bridge"]
      .map((id) => byId(assignments, id).delivery_key);
    expect(new Set(keys).size).toBe(3);
    expect(byId(assignments, "digest-less-bridge").evidence.parse_warnings)
      .toContain("delivery_authored_fingerprint_conflict");
    expect(byId(assignments, "digest-less-bridge").evidence.parse_warnings)
      .toContain("delivery_metadata_collision_authored_conflict");
  });

  it("collapses copies when exact parsed evidence bridges raw and parsed-only storage", () => {
    const inputs = [
      message("raw-copy", {
        folder_path: "INBOX",
        uid: 10,
        rfc_message_id: "<cross-tier-copy@x>",
        raw_mime_hash: "exact-wire-hash",
        delivery_fingerprint: "same-complete-parsed-message"
      }),
      message("parsed-only-copy", {
        folder_path: "INBOX.INBOX",
        uid: 10,
        rfc_message_id: "<cross-tier-copy@x>",
        delivery_fingerprint: "same-complete-parsed-message"
      })
    ];
    const assignments = computeThreadAssignments(inputs);

    expect(THREADING_ALGORITHM_VERSION).toBe(3);
    expect(byId(assignments, "raw-copy").delivery_key)
      .toBe(byId(assignments, "parsed-only-copy").delivery_key);
    expect(byId(assignments, "raw-copy").evidence.collapsed_physical_ids)
      .toEqual(["parsed-only-copy", "raw-copy"]);
    expect(assignments.every((assignment) => assignment.algorithm_version === 3)).toBe(true);

    const retainedV2 = computeThreadAssignmentsV2(inputs);
    expect(byId(retainedV2, "raw-copy").delivery_key)
      .toBe(byId(retainedV2, "parsed-only-copy").delivery_key);
    expect(retainedV2.every((assignment) => assignment.algorithm_version === 2)).toBe(true);

    const retainedV1 = computeThreadAssignmentsV1(inputs);
    expect(byId(retainedV1, "raw-copy").delivery_key)
      .not.toBe(byId(retainedV1, "parsed-only-copy").delivery_key);
    expect(retainedV1.every((assignment) => assignment.algorithm_version === 1)).toBe(true);
  });

  it("uses authored evidence across transport-mutated raw copies without changing v1", () => {
    const inputs = [
      message("sent-copy", {
        folder_path: "Sent",
        rfc_message_id: "<transport-mutated@x>",
        raw_mime_hash: "sent-wire-hash",
        authored_delivery_fingerprint: "same-authored-message"
      }),
      message("received-copy", {
        folder_path: "INBOX",
        rfc_message_id: "<transport-mutated@x>",
        raw_mime_hash: "received-wire-hash",
        authored_delivery_fingerprint: "same-authored-message"
      })
    ];

    const assignments = computeThreadAssignments(inputs);
    expect(byId(assignments, "sent-copy").delivery_key)
      .toBe(byId(assignments, "received-copy").delivery_key);

    const retainedV1 = computeThreadAssignmentsV1(inputs);
    expect(byId(retainedV1, "sent-copy").delivery_key)
      .not.toBe(byId(retainedV1, "received-copy").delivery_key);
  });

  it("keeps authored-only delivery evidence unavailable to retained v1 runs", () => {
    const inputs = [
      message("sent-copy", {
        folder_path: "Sent",
        rfc_message_id: "<authored-only@x>",
        authored_delivery_fingerprint: "same-authored-message"
      }),
      message("received-copy", {
        folder_path: "INBOX",
        rfc_message_id: "<authored-only@x>",
        authored_delivery_fingerprint: "same-authored-message"
      })
    ];

    const assignments = computeThreadAssignments(inputs);
    expect(byId(assignments, "sent-copy").delivery_key)
      .toBe(byId(assignments, "received-copy").delivery_key);

    const retainedV1 = computeThreadAssignmentsV1(inputs);
    expect(byId(retainedV1, "sent-copy").delivery_key)
      .not.toBe(byId(retainedV1, "received-copy").delivery_key);
  });

  it("prefers an account-scoped provider message identity over inconsistent RFC ids", () => {
    const assignments = computeThreadAssignments([
      message("provider-copy-a", {
        provider_message_namespace: "gmail",
        provider_message_id: "gm-123",
        rfc_message_id: "<first@x>"
      }),
      message("provider-copy-b", {
        provider_message_namespace: "gmail",
        provider_message_id: "gm-123",
        rfc_message_id: "<rewritten@x>"
      })
    ]);

    expect(byId(assignments, "provider-copy-a").delivery_key).toBe(byId(assignments, "provider-copy-b").delivery_key);
    expect(byId(assignments, "provider-copy-a").strict_message_id).toBeNull();
    expect(byId(assignments, "provider-copy-a").evidence.parse_warnings)
      .toContain("delivery_copies_disagree_on_message_id");
  });

  it("refuses to choose an arbitrary parent when verified copies contradict each other", () => {
    const assignments = computeThreadAssignments([
      message("copy-parent-a", { rfc_message_id: "<copy-parent-a@x>" }),
      message("copy-parent-b", { rfc_message_id: "<copy-parent-b@x>" }),
      message("conflicting-copy-a", {
        provider_message_namespace: "gmail",
        provider_message_id: "same-delivery",
        rfc_message_id: "<same-delivery@x>",
        references_header: "<copy-parent-a@x>"
      }),
      message("conflicting-copy-b", {
        folder_path: "Archive",
        provider_message_namespace: "gmail",
        provider_message_id: "same-delivery",
        rfc_message_id: "<same-delivery@x>",
        references_header: "<copy-parent-b@x>"
      })
    ]);
    const copy = byId(assignments, "conflicting-copy-a");

    expect(copy.reference_ids).toEqual([]);
    expect(copy.parent_reference).toBeNull();
    expect(copy.conversation_id).not.toBe(byId(assignments, "copy-parent-a").conversation_id);
    expect(copy.conversation_id).not.toBe(byId(assignments, "copy-parent-b").conversation_id);
    expect(copy.evidence.parse_warnings).toContain("delivery_copies_disagree_on_reply_headers");
  });

  it("does not collapse, group, or arbitrarily resolve incompatible deliveries that reuse one Message-ID", () => {
    const assignments = computeThreadAssignments([
      message("duplicate-a", {
        rfc_message_id: "<reused@x>"
      }),
      message("duplicate-b", {
        // Every available envelope field intentionally matches duplicate-a.
        // Message-ID alone is still insufficient proof that these are copies.
        rfc_message_id: "<reused@x>"
      }),
      message("ambiguous-child", {
        rfc_message_id: "<child-of-reused@x>",
        in_reply_to: "<reused@x>"
      })
    ]);

    const first = byId(assignments, "duplicate-a");
    const second = byId(assignments, "duplicate-b");
    const child = byId(assignments, "ambiguous-child");
    expect(first.delivery_key).not.toBe(second.delivery_key);
    expect(first.conversation_id).not.toBe(second.conversation_id);
    expect(first.root_reference).toBeNull();
    expect(second.root_reference).toBeNull();
    expect(child.conversation_id).not.toBe(first.conversation_id);
    expect(child.conversation_id).not.toBe(second.conversation_id);
    expect(child).toMatchObject({
      parent_reference: "reused@x",
      parent_delivery_key: null,
      provisional: true
    });
    expect(first.evidence.parse_warnings).toContain("ambiguous_message_id_owner");
    expect(first.evidence.parse_warnings).toContain("delivery_metadata_same_folder_ignored");
  });

  it("does not merge separate replies through a reused Message-ID ambiguity", () => {
    const inputs = [
      message("reused-owner-a", { rfc_message_id: "<multiply-owned@x>" }),
      message("reused-owner-b", { rfc_message_id: "<multiply-owned@x>" }),
      message("reused-child-a", {
        rfc_message_id: "<reused-child-a@x>",
        in_reply_to: "<multiply-owned@x>"
      }),
      message("reused-child-b", {
        rfc_message_id: "<reused-child-b@x>",
        in_reply_to: "<multiply-owned@x>"
      })
    ];
    const assignments = computeThreadAssignments(inputs);

    const childA = byId(assignments, "reused-child-a");
    const childB = byId(assignments, "reused-child-b");
    expect(childA.conversation_id).not.toBe(childB.conversation_id);
    expect(childA).toMatchObject({
      parent_reference: "multiply-owned@x",
      parent_delivery_key: null,
      provisional: true
    });
    expect(childA.evidence.parse_warnings).toContain("ambiguous_parent_reference_isolated");
    expect(childB.evidence.parse_warnings).toContain("ambiguous_parent_reference_isolated");
    expect(computeThreadAssignments([...inputs].reverse())).toEqual(assignments);
  });
});

describe("provider and conservative subject grouping", () => {
  it("groups provider thread ids within one account but never across accounts", () => {
    const assignments = computeThreadAssignments([
      message("provider-a", {
        rfc_message_id: null,
        provider_thread_namespace: "gmail",
        provider_thread_id: "thread-42"
      }),
      message("provider-b", {
        rfc_message_id: null,
        provider_thread_namespace: "gmail",
        provider_thread_id: "thread-42"
      }),
      message("other-account", {
        account_id: "account-b",
        rfc_message_id: null,
        provider_thread_namespace: "gmail",
        provider_thread_id: "thread-42"
      })
    ]);

    expect(byId(assignments, "provider-a").conversation_id).toBe(byId(assignments, "provider-b").conversation_id);
    expect(byId(assignments, "provider-a").conversation_id).not.toBe(byId(assignments, "other-account").conversation_id);
    expect(byId(assignments, "provider-a")).toMatchObject({
      method: "provider_thread",
      confidence: "medium",
      parent_reference: null,
      provider_thread_key: "gmail:thread-42"
    });
  });

  it("uses the shared provider key when provider evidence joins multiple RFC roots", () => {
    const provider = {
      provider_thread_namespace: "gmail",
      provider_thread_id: "stable-provider-thread"
    } as const;
    const firstInputs = [
      message("provider-anchor-z", { ...provider, rfc_message_id: "<z-provider@x>" }),
      message("provider-anchor-m", { ...provider, rfc_message_id: "<m-provider@x>" })
    ];
    const before = computeThreadAssignments(firstInputs);
    const priorConversation = byId(before, "provider-anchor-z").conversation_id;
    expect(byId(before, "provider-anchor-z")).toMatchObject({
      root_reference: null,
      conversation_anchor: "provider:gmail:stable-provider-thread"
    });

    const after = computeThreadAssignments([
      ...firstInputs,
      message("provider-anchor-a", { ...provider, rfc_message_id: "<a-provider@x>" })
    ]);
    expect(byId(after, "provider-anchor-z").conversation_id).toBe(priorConversation);
    expect(byId(after, "provider-anchor-a").conversation_id).toBe(priorConversation);
  });

  it("uses reciprocal Re: fallback only for a unique standalone human pair", () => {
    const inputs = [
      message("subject-root", {
        rfc_message_id: "<subject-root@x>",
        subject: "Contract review",
        from_email: "alice@example.test",
        to_emails: ["bob@example.test"],
        internal_date: "2026-01-01T10:00:00Z"
      }),
      message("subject-reply", {
        rfc_message_id: "<subject-reply@x>",
        subject: "Re: Contract review",
        from_email: "bob@example.test",
        to_emails: ["alice@example.test"],
        internal_date: "2026-01-02T10:00:00Z"
      })
    ];

    const assignments = computeThreadAssignments(inputs);
    expect(byId(assignments, "subject-root").conversation_id).toBe(byId(assignments, "subject-reply").conversation_id);
    expect(byId(assignments, "subject-root").method).toBe("subject_fallback");
    expect(byId(assignments, "subject-reply")).toMatchObject({
      method: "subject_fallback",
      confidence: "low",
      parent_reference: null,
      provisional: true,
      subject_base: "contract review"
    });

    const disabled = computeThreadAssignments(inputs, { allowSubjectFallback: false });
    expect(byId(disabled, "subject-root").conversation_id)
      .not.toBe(byId(disabled, "subject-reply").conversation_id);
    expect(byId(disabled, "subject-reply").method).toBe("standalone");
  });

  it("anchors a subject-fallback conversation to the selected human root", () => {
    const root = message("anchor-root", {
      rfc_message_id: "<z-root@x>",
      subject: "Dinner",
      from_email: "alice@example.test",
      to_emails: ["bob@example.test"],
      internal_date: "2026-01-01T10:00:00Z"
    });
    const firstReply = message("anchor-reply-a", {
      rfc_message_id: "<a-reply@x>",
      subject: "Re: Dinner",
      from_email: "bob@example.test",
      to_emails: ["alice@example.test"],
      internal_date: "2026-01-02T10:00:00Z"
    });
    const before = computeThreadAssignments([root, firstReply]);
    const priorConversation = byId(before, "anchor-root").conversation_id;
    expect(byId(before, "anchor-root")).toMatchObject({
      root_reference: "z-root@x",
      conversation_anchor: "reference:z-root@x"
    });

    const after = computeThreadAssignments([
      root,
      firstReply,
      message("anchor-reply-zero", {
        rfc_message_id: "<0-reply@x>",
        subject: "Re: Dinner",
        from_email: "bob@example.test",
        to_emails: ["alice@example.test"],
        internal_date: "2026-01-03T10:00:00Z"
      })
    ]);
    expect(byId(after, "anchor-root").conversation_id).toBe(priorConversation);
    expect(byId(after, "anchor-reply-zero").root_reference).toBe("z-root@x");
  });

  it("does not case-fold distinct mailbox local-parts for weak participant evidence", () => {
    const assignments = computeThreadAssignments([
      message("case-root", {
        rfc_message_id: "<case-root@x>",
        subject: "Access",
        from_email: "owner@example.test",
        to_emails: ["User@example.test"],
        internal_date: "2026-01-01T10:00:00Z"
      }),
      message("case-reply", {
        rfc_message_id: "<case-reply@x>",
        subject: "Re: Access",
        from_email: "user@example.test",
        to_emails: ["owner@example.test"],
        internal_date: "2026-01-02T10:00:00Z"
      })
    ]);

    expect(byId(assignments, "case-root").conversation_id)
      .not.toBe(byId(assignments, "case-reply").conversation_id);
  });

  it("does not use subject fallback when a malformed reply header points elsewhere", () => {
    const assignments = computeThreadAssignments([
      message("malformed-fallback-root", {
        rfc_message_id: "<malformed-fallback-root@x>",
        subject: "Budget",
        from_email: "alice@example.test",
        to_emails: ["bob@example.test"],
        internal_date: "2026-01-01T10:00:00Z"
      }),
      message("malformed-fallback-reply", {
        rfc_message_id: "<malformed-fallback-reply@x>",
        in_reply_to: "different-parent@x",
        subject: "Re: Budget",
        from_email: "bob@example.test",
        to_emails: ["alice@example.test"],
        internal_date: "2026-01-02T10:00:00Z"
      })
    ]);

    expect(byId(assignments, "malformed-fallback-root").conversation_id)
      .not.toBe(byId(assignments, "malformed-fallback-reply").conversation_id);
    expect(byId(assignments, "malformed-fallback-reply").evidence.parse_warnings)
      .toContain("malformed_in_reply_to_ignored");
  });

  it("does not merge forwards, automated replies, or ambiguous subject reuse", () => {
    const assignments = computeThreadAssignments([
      message("reuse-root-1", {
        rfc_message_id: "<reuse-1@x>",
        subject: "Status report",
        internal_date: "2026-01-01T10:00:00Z"
      }),
      message("reuse-root-2", {
        rfc_message_id: "<reuse-2@x>",
        subject: "Status report",
        internal_date: "2026-01-02T10:00:00Z"
      }),
      message("ambiguous-reply", {
        rfc_message_id: "<ambiguous-reply@x>",
        subject: "Re: Status report",
        from_email: "bob@example.test",
        to_emails: ["alice@example.test"],
        internal_date: "2026-01-03T10:00:00Z"
      }),
      message("forward", {
        rfc_message_id: "<forward@x>",
        subject: "Fwd: Status report",
        from_email: "bob@example.test",
        to_emails: ["alice@example.test"],
        internal_date: "2026-01-03T10:00:00Z"
      }),
      message("automated", {
        rfc_message_id: "<automated@x>",
        subject: "Re: Status report",
        from_email: "bob@example.test",
        to_emails: ["alice@example.test"],
        auto_submitted: "auto-replied",
        internal_date: "2026-01-03T10:00:00Z"
      })
    ]);

    const ids = ["reuse-root-1", "reuse-root-2", "ambiguous-reply", "forward", "automated"]
      .map((id) => byId(assignments, id).conversation_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(byId(assignments, "ambiguous-reply").method).toBe("standalone");
    expect(byId(assignments, "forward").method).toBe("standalone");
    expect(byId(assignments, "automated").method).toBe("standalone");
  });

  it("starts a new conversation for a forward even when it inherits reply headers", () => {
    const inputs = [
      message("forwarded-root", {
        rfc_message_id: "<forwarded-root@x>",
        provider_thread_namespace: "outlook",
        provider_thread_id: "inherited-forward-thread",
        subject: "Project Atlas"
      }),
      message("forwarded-outer", {
        rfc_message_id: "<forwarded-outer@x>",
        references_header: "<forwarded-root@x>",
        in_reply_to: "<forwarded-root@x>",
        provider_thread_namespace: "outlook",
        provider_thread_id: "inherited-forward-thread",
        subject: "Fwd: Project Atlas"
      }),
      message("forwarded-reply", {
        rfc_message_id: "<forwarded-reply@x>",
        references_header: "<forwarded-root@x> <forwarded-outer@x>",
        in_reply_to: "<forwarded-outer@x>",
        provider_thread_namespace: "outlook",
        provider_thread_id: "inherited-forward-thread",
        subject: "Re: Fwd: Project Atlas"
      })
    ];
    const assignments = computeThreadAssignments(inputs);

    expect(byId(assignments, "forwarded-root").conversation_id)
      .not.toBe(byId(assignments, "forwarded-outer").conversation_id);
    expect(byId(assignments, "forwarded-outer").conversation_id)
      .toBe(byId(assignments, "forwarded-reply").conversation_id);
    expect(byId(assignments, "forwarded-outer").reference_ids).toEqual([]);
    expect(byId(assignments, "forwarded-outer").evidence.parse_warnings)
      .toContain("forward_reply_headers_not_conversation_edge");
    expect(byId(assignments, "forwarded-outer").evidence.parse_warnings)
      .toContain("forward_provider_thread_not_conversation_edge");

    const retainedV2 = computeThreadAssignmentsV2(inputs);
    expect(byId(retainedV2, "forwarded-root").conversation_id)
      .toBe(byId(retainedV2, "forwarded-outer").conversation_id);
    expect(byId(retainedV2, "forwarded-outer").conversation_id)
      .toBe(byId(retainedV2, "forwarded-reply").conversation_id);
  });

  it("recognizes localized forward prefixes as authored boundaries", () => {
    const inputs = [
      message("localized-root", { rfc_message_id: "<localized-root@x>" }),
      message("localized-forward", {
        rfc_message_id: "<localized-forward@x>",
        references_header: "<localized-root@x>",
        in_reply_to: "<localized-root@x>",
        subject: "RV: Project Atlas"
      })
    ];

    const assignments = computeThreadAssignments(inputs);
    expect(byId(assignments, "localized-root").conversation_id)
      .not.toBe(byId(assignments, "localized-forward").conversation_id);
    expect(byId(assignments, "localized-forward").evidence.parse_warnings)
      .toContain("forward_reply_headers_not_conversation_edge");

    const retainedV2 = computeThreadAssignmentsV2(inputs);
    expect(byId(retainedV2, "localized-root").conversation_id)
      .toBe(byId(retainedV2, "localized-forward").conversation_id);
  });
});

describe("determinism", () => {
  it("orders outputs by binary code units rather than the host locale", () => {
    const assignments = computeThreadAssignments([
      message("a", { rfc_message_id: "<lower@x>" }),
      message("A", { rfc_message_id: "<upper@x>" })
    ]);

    expect(assignments.map((assignment) => assignment.physical_message_id)).toEqual(["A", "a"]);
  });

  it("returns byte-identical assignments for randomized input orders", () => {
    const inputs = [
      message("det-root", { rfc_message_id: "<det-root@x>", internal_date: "2026-01-01T10:00:00Z" }),
      message("det-child", {
        rfc_message_id: "<det-child@x>",
        references_header: "<det-root@x>",
        internal_date: "2026-01-01T11:00:00Z"
      }),
      message("det-orphan", {
        rfc_message_id: "<det-orphan@x>",
        in_reply_to: "<missing@x>",
        internal_date: "2026-01-01T12:00:00Z"
      }),
      message("det-provider-a", {
        rfc_message_id: null,
        provider_thread_namespace: "gmail",
        provider_thread_id: "det-provider"
      }),
      message("det-provider-b", {
        rfc_message_id: null,
        provider_thread_namespace: "gmail",
        provider_thread_id: "det-provider"
      })
    ];
    const expected = computeThreadAssignments(inputs);
    const permutations = [
      [...inputs].reverse(),
      [...inputs.slice(2), ...inputs.slice(0, 2)],
      [inputs[3], inputs[0], inputs[4], inputs[2], inputs[1]]
    ];

    for (const permutation of permutations) {
      expect(computeThreadAssignments(permutation)).toEqual(expected);
    }
    expect(expected.every((assignment) => /^[a-f0-9]{64}$/.test(assignment.input_hash))).toBe(true);
  });
});
