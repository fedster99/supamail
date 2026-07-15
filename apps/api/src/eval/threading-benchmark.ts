import {
  computeThreadAssignments,
  type ThreadingAssignment,
  type ThreadingMessageInput
} from "../threading.js";

/**
 * Small, hand-labeled release-gate corpus.
 *
 * The messages are synthetic so this file is safe to publish. The gold labels
 * are written explicitly rather than copied from the algorithm. In particular,
 * `rain_style_notifications` is only a regression shape inspired by the class
 * of same-document notification failures; it is not claimed to reproduce a
 * private production incident.
 */
export interface ThreadingBenchmarkCase {
  id: string;
  slice: string;
  messages: ThreadingMessageInput[];
  /** Equal labels mean one delivered email; different labels mean distinct deliveries. */
  deliveryLabels: Record<string, string>;
  /** Equal labels mean one protocol conversation; different labels mean distinct conversations. */
  conversationLabels: Record<string, string>;
  /** Especially costly negative pairs that must never be joined. */
  dangerousFalseMergePairs?: Array<readonly [string, string]>;
}

function message(
  id: string,
  overrides: Partial<ThreadingMessageInput> = {}
): ThreadingMessageInput {
  return {
    id,
    account_id: "benchmark-account",
    folder_path: "INBOX",
    uidvalidity: "1",
    uid: id,
    internal_date: "2026-01-01T12:00:00.000Z",
    size_bytes: 1_000,
    subject: "Benchmark",
    from_email: "alice@example.test",
    to_emails: ["bob@example.test"],
    ...overrides
  };
}

export const THREADING_BENCHMARK: readonly ThreadingBenchmarkCase[] = [
  {
    id: "normal_references_chain",
    slice: "normal_reply",
    messages: [
      message("normal-root", { rfc_message_id: "<normal-root@x>" }),
      message("normal-one", {
        rfc_message_id: "<normal-one@x>",
        in_reply_to: "<normal-root@x>",
        internal_date: "2026-01-01T13:00:00Z"
      }),
      message("normal-two", {
        rfc_message_id: "<normal-two@x>",
        references_header: "<normal-root@x> <normal-one@x>",
        subject: "A completely changed subject",
        internal_date: "2026-01-01T14:00:00Z"
      })
    ],
    deliveryLabels: { "normal-root": "d1", "normal-one": "d2", "normal-two": "d3" },
    conversationLabels: { "normal-root": "c1", "normal-one": "c1", "normal-two": "c1" }
  },
  {
    id: "shared_missing_parent",
    slice: "missing_parent",
    messages: [
      message("orphan-one", { rfc_message_id: "<orphan-one@x>", in_reply_to: "<missing@x>" }),
      message("orphan-two", { rfc_message_id: "<orphan-two@x>", in_reply_to: "<missing@x>" })
    ],
    deliveryLabels: { "orphan-one": "d1", "orphan-two": "d2" },
    conversationLabels: { "orphan-one": "c1", "orphan-two": "c1" }
  },
  {
    id: "late_parent_resolution",
    slice: "late_parent",
    messages: [
      message("late-root", { rfc_message_id: "<late@x>", internal_date: "2026-01-01T10:00:00Z" }),
      message("late-child", { rfc_message_id: "<late-child@x>", in_reply_to: "<late@x>" })
    ],
    deliveryLabels: { "late-root": "d1", "late-child": "d2" },
    conversationLabels: { "late-root": "c1", "late-child": "c1" }
  },
  {
    id: "long_lived_explicit_chain_with_subject_reuse",
    slice: "long_lived_conversation",
    messages: [
      message("long-root", {
        rfc_message_id: "<long-root@x>",
        subject: "Quarterly board update",
        internal_date: "2020-01-01T12:00:00Z"
      }),
      message("long-middle", {
        rfc_message_id: "<long-middle@x>",
        references_header: "<long-root@x>",
        subject: "Re: Quarterly board update",
        from_email: "bob@example.test",
        to_emails: ["alice@example.test"],
        internal_date: "2023-01-01T12:00:00Z"
      }),
      message("long-latest", {
        rfc_message_id: "<long-latest@x>",
        references_header: "<long-root@x> <long-middle@x>",
        subject: "Decision recorded: expansion approved",
        internal_date: "2026-01-01T12:00:00Z"
      }),
      message("long-reused-subject", {
        rfc_message_id: "<long-reused-subject@x>",
        subject: "Quarterly board update",
        internal_date: "2026-01-02T12:00:00Z"
      })
    ],
    deliveryLabels: {
      "long-root": "d1",
      "long-middle": "d2",
      "long-latest": "d3",
      "long-reused-subject": "d4"
    },
    conversationLabels: {
      "long-root": "c1",
      "long-middle": "c1",
      "long-latest": "c1",
      "long-reused-subject": "c2"
    },
    dangerousFalseMergePairs: [["long-root", "long-reused-subject"]]
  },
  {
    id: "forward_is_new_conversation",
    slice: "forward",
    messages: [
      message("forward-source", { rfc_message_id: "<forward-source@x>", subject: "Board packet" }),
      message("forward-copy", {
        rfc_message_id: "<forward-copy@x>",
        subject: "Fwd: Board packet",
        from_email: "bob@example.test",
        to_emails: ["alice@example.test"]
      })
    ],
    deliveryLabels: { "forward-source": "d1", "forward-copy": "d2" },
    conversationLabels: { "forward-source": "c1", "forward-copy": "c2" },
    dangerousFalseMergePairs: [["forward-source", "forward-copy"]]
  },
  {
    id: "malformed_bare_parent",
    slice: "malformed_header",
    messages: [
      message("malformed-root", { rfc_message_id: "<valid-root@x>" }),
      message("malformed-child", {
        rfc_message_id: "<valid-child@x>",
        in_reply_to: "valid-root@x"
      })
    ],
    deliveryLabels: { "malformed-root": "d1", "malformed-child": "d2" },
    conversationLabels: { "malformed-root": "c1", "malformed-child": "c2" },
    dangerousFalseMergePairs: [["malformed-root", "malformed-child"]]
  },
  {
    id: "alias_reply_with_protocol_evidence",
    slice: "alias",
    messages: [
      message("alias-root", {
        rfc_message_id: "<alias-root@x>",
        from_email: "team@example.test",
        to_emails: ["customer@example.test"]
      }),
      message("alias-reply", {
        rfc_message_id: "<alias-reply@x>",
        in_reply_to: "<alias-root@x>",
        from_email: "customer@example.test",
        to_emails: ["agent+team@example.test"]
      })
    ],
    deliveryLabels: { "alias-root": "d1", "alias-reply": "d2" },
    conversationLabels: { "alias-root": "c1", "alias-reply": "c1" }
  },
  {
    id: "automated_reminders_reuse_subject",
    slice: "automated_reminder",
    messages: [
      message("reminder-one", {
        rfc_message_id: "<reminder-one@x>",
        subject: "Action required",
        auto_submitted: "auto-generated"
      }),
      message("reminder-two", {
        rfc_message_id: "<reminder-two@x>",
        subject: "Re: Action required",
        from_email: "bob@example.test",
        to_emails: ["alice@example.test"],
        precedence: "bulk"
      })
    ],
    deliveryLabels: { "reminder-one": "d1", "reminder-two": "d2" },
    conversationLabels: { "reminder-one": "c1", "reminder-two": "c2" },
    dangerousFalseMergePairs: [["reminder-one", "reminder-two"]]
  },
  {
    id: "ambiguous_reused_subject",
    slice: "subject_reuse",
    messages: [
      message("status-one", { rfc_message_id: "<status-one@x>", subject: "Status" }),
      message("status-two", {
        rfc_message_id: "<status-two@x>",
        subject: "Status",
        internal_date: "2026-01-02T12:00:00Z"
      }),
      message("status-reply", {
        rfc_message_id: "<status-reply@x>",
        subject: "Re: Status",
        from_email: "bob@example.test",
        to_emails: ["alice@example.test"],
        internal_date: "2026-01-03T12:00:00Z"
      })
    ],
    deliveryLabels: { "status-one": "d1", "status-two": "d2", "status-reply": "d3" },
    conversationLabels: { "status-one": "c1", "status-two": "c2", "status-reply": "c3" },
    dangerousFalseMergePairs: [["status-one", "status-reply"], ["status-two", "status-reply"]]
  },
  {
    id: "unique_human_subject_fallback",
    slice: "subject_fallback",
    messages: [
      message("fallback-root", {
        rfc_message_id: "<fallback-root@x>",
        subject: "Dinner",
        internal_date: "2026-01-01T12:00:00Z"
      }),
      message("fallback-reply", {
        rfc_message_id: "<fallback-reply@x>",
        subject: "Re: Dinner",
        from_email: "bob@example.test",
        to_emails: ["alice@example.test"],
        internal_date: "2026-01-02T12:00:00Z"
      })
    ],
    deliveryLabels: { "fallback-root": "d1", "fallback-reply": "d2" },
    conversationLabels: { "fallback-root": "c1", "fallback-reply": "c1" }
  },
  {
    id: "reused_message_id_is_not_copy_proof",
    slice: "dangerous_duplicate_message_id",
    messages: [
      message("reused-id-one", { rfc_message_id: "<reused@x>" }),
      message("reused-id-two", { rfc_message_id: "<reused@x>" })
    ],
    deliveryLabels: { "reused-id-one": "d1", "reused-id-two": "d2" },
    conversationLabels: { "reused-id-one": "c1", "reused-id-two": "c2" },
    dangerousFalseMergePairs: [["reused-id-one", "reused-id-two"]]
  },
  {
    id: "raw_mime_proves_delivery_copies",
    slice: "delivery_copy",
    messages: [
      message("copy-inbox", {
        rfc_message_id: "<copy@x>",
        folder_path: "INBOX",
        raw_mime_hash: "sha256-identical"
      }),
      message("copy-archive", {
        rfc_message_id: "<copy@x>",
        folder_path: "Archive",
        raw_mime_hash: "sha256-identical"
      })
    ],
    deliveryLabels: { "copy-inbox": "d1", "copy-archive": "d1" },
    conversationLabels: { "copy-inbox": "c1", "copy-archive": "c1" }
  },
  {
    id: "provider_identity_is_account_scoped",
    slice: "provider_identity",
    messages: [
      message("provider-a-one", {
        rfc_message_id: null,
        provider_thread_namespace: "gmail",
        provider_thread_id: "shared-opaque-id"
      }),
      message("provider-a-two", {
        rfc_message_id: null,
        provider_thread_namespace: "gmail",
        provider_thread_id: "shared-opaque-id"
      }),
      message("provider-b", {
        account_id: "other-account",
        rfc_message_id: null,
        provider_thread_namespace: "gmail",
        provider_thread_id: "shared-opaque-id"
      })
    ],
    deliveryLabels: { "provider-a-one": "d1", "provider-a-two": "d2", "provider-b": "d3" },
    conversationLabels: { "provider-a-one": "c1", "provider-a-two": "c1", "provider-b": "c2" },
    dangerousFalseMergePairs: [["provider-a-one", "provider-b"]]
  },
  {
    id: "provider_delivery_identity",
    slice: "provider_delivery_copy",
    messages: [
      message("provider-copy-one", {
        provider_message_namespace: "gmail",
        provider_message_id: "message-42",
        rfc_message_id: "<provider-copy@x>"
      }),
      message("provider-copy-two", {
        folder_path: "All Mail",
        provider_message_namespace: "gmail",
        provider_message_id: "message-42",
        rfc_message_id: "<provider-copy@x>"
      })
    ],
    deliveryLabels: { "provider-copy-one": "d1", "provider-copy-two": "d1" },
    conversationLabels: { "provider-copy-one": "c1", "provider-copy-two": "c1" }
  },
  {
    id: "malformed_reply_blocks_subject_fallback",
    slice: "malformed_reply_blocks_subject_fallback",
    messages: [
      message("malformed-fallback-root", {
        rfc_message_id: "<malformed-fallback-root@x>",
        subject: "Capacity plan",
        from_email: "alice@example.test",
        to_emails: ["bob@example.test"]
      }),
      message("malformed-fallback-reply", {
        rfc_message_id: "<malformed-fallback-reply@x>",
        in_reply_to: "some-other-parent@x",
        subject: "Re: Capacity plan",
        from_email: "bob@example.test",
        to_emails: ["alice@example.test"],
        internal_date: "2026-01-02T12:00:00Z"
      })
    ],
    deliveryLabels: { "malformed-fallback-root": "d1", "malformed-fallback-reply": "d2" },
    conversationLabels: { "malformed-fallback-root": "c1", "malformed-fallback-reply": "c2" },
    dangerousFalseMergePairs: [["malformed-fallback-root", "malformed-fallback-reply"]]
  },
  {
    id: "participant_local_part_case_collision",
    slice: "participant_local_part_case_collision",
    messages: [
      message("case-sensitive-root", {
        rfc_message_id: "<case-sensitive-root@x>",
        subject: "Access request",
        from_email: "owner@example.test",
        to_emails: ["User@example.test"]
      }),
      message("case-sensitive-reply", {
        rfc_message_id: "<case-sensitive-reply@x>",
        subject: "Re: Access request",
        from_email: "user@EXAMPLE.TEST",
        to_emails: ["owner@example.test"],
        internal_date: "2026-01-02T12:00:00Z"
      })
    ],
    deliveryLabels: { "case-sensitive-root": "d1", "case-sensitive-reply": "d2" },
    conversationLabels: { "case-sensitive-root": "c1", "case-sensitive-reply": "c2" },
    dangerousFalseMergePairs: [["case-sensitive-root", "case-sensitive-reply"]]
  },
  {
    id: "verified_copy_reply_header_conflict",
    slice: "verified_copy_reply_header_conflict",
    messages: [
      message("copy-conflict-parent-a", { rfc_message_id: "<copy-conflict-parent-a@x>" }),
      message("copy-conflict-parent-b", { rfc_message_id: "<copy-conflict-parent-b@x>" }),
      message("copy-conflict-inbox", {
        provider_message_namespace: "gmail",
        provider_message_id: "same-delivery-conflict",
        rfc_message_id: "<same-delivery-conflict@x>",
        references_header: "<copy-conflict-parent-a@x>"
      }),
      message("copy-conflict-archive", {
        folder_path: "Archive",
        provider_message_namespace: "gmail",
        provider_message_id: "same-delivery-conflict",
        rfc_message_id: "<same-delivery-conflict@x>",
        references_header: "<copy-conflict-parent-b@x>"
      })
    ],
    deliveryLabels: {
      "copy-conflict-parent-a": "d1",
      "copy-conflict-parent-b": "d2",
      "copy-conflict-inbox": "d3",
      "copy-conflict-archive": "d3"
    },
    conversationLabels: {
      "copy-conflict-parent-a": "c1",
      "copy-conflict-parent-b": "c2",
      "copy-conflict-inbox": "c3",
      "copy-conflict-archive": "c3"
    },
    dangerousFalseMergePairs: [
      ["copy-conflict-parent-a", "copy-conflict-inbox"],
      ["copy-conflict-parent-b", "copy-conflict-inbox"]
    ]
  },
  {
    id: "rain_style_notifications",
    slice: "synthetic_rain_style_regression",
    messages: [
      message("rain-notice-one", {
        rfc_message_id: "<rain-notice-one@x>",
        subject: "Decision requested: Rain document",
        from_email: "notifications@example.test",
        to_emails: ["alice@example.test"],
        list_id: "document-notifications.example.test"
      }),
      message("rain-notice-two", {
        rfc_message_id: "<rain-notice-two@x>",
        subject: "Re: Decision requested: Rain document",
        from_email: "alice@example.test",
        to_emails: ["notifications@example.test"],
        list_id: "document-notifications.example.test",
        internal_date: "2026-01-02T12:00:00Z"
      })
    ],
    deliveryLabels: { "rain-notice-one": "d1", "rain-notice-two": "d2" },
    conversationLabels: { "rain-notice-one": "c1", "rain-notice-two": "c2" },
    dangerousFalseMergePairs: [["rain-notice-one", "rain-notice-two"]]
  }
];

interface PairwiseCounts {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
}

export interface PairwiseScore extends PairwiseCounts {
  precision: number;
  recall: number;
  f1: number;
}

export interface ThreadingBenchmarkResult {
  delivery: PairwiseScore;
  conversation: PairwiseScore;
  dangerousFalseMerges: number;
  cases: number;
  messages: number;
  slices: string[];
}

function score(counts: PairwiseCounts): PairwiseScore {
  const precision = counts.truePositive + counts.falsePositive === 0
    ? 1
    : counts.truePositive / (counts.truePositive + counts.falsePositive);
  const recall = counts.truePositive + counts.falseNegative === 0
    ? 1
    : counts.truePositive / (counts.truePositive + counts.falseNegative);
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  return { ...counts, precision, recall, f1 };
}

function addPair(
  counts: PairwiseCounts,
  expectedSame: boolean,
  predictedSame: boolean
): void {
  if (expectedSame && predictedSame) counts.truePositive += 1;
  else if (!expectedSame && predictedSame) counts.falsePositive += 1;
  else if (expectedSame) counts.falseNegative += 1;
  else counts.trueNegative += 1;
}

function assignmentById(assignments: ThreadingAssignment[]): Map<string, ThreadingAssignment> {
  return new Map(assignments.map((assignment) => [assignment.physical_message_id, assignment]));
}

export function evaluateThreadingBenchmark(
  cases: readonly ThreadingBenchmarkCase[] = THREADING_BENCHMARK
): ThreadingBenchmarkResult {
  const delivery: PairwiseCounts = { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 };
  const conversation: PairwiseCounts = { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 };
  let dangerousFalseMerges = 0;
  let messages = 0;

  for (const benchmarkCase of cases) {
    const assignments = assignmentById(computeThreadAssignments(benchmarkCase.messages));
    const ids = benchmarkCase.messages.map((entry) => entry.id);
    messages += ids.length;
    for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
        const left = ids[leftIndex];
        const right = ids[rightIndex];
        const predictedLeft = assignments.get(left);
        const predictedRight = assignments.get(right);
        if (!predictedLeft || !predictedRight) throw new Error(`Missing benchmark assignment in ${benchmarkCase.id}`);
        addPair(
          delivery,
          benchmarkCase.deliveryLabels[left] === benchmarkCase.deliveryLabels[right],
          predictedLeft.delivery_key === predictedRight.delivery_key
        );
        addPair(
          conversation,
          benchmarkCase.conversationLabels[left] === benchmarkCase.conversationLabels[right],
          predictedLeft.conversation_id === predictedRight.conversation_id
        );
      }
    }

    for (const [left, right] of benchmarkCase.dangerousFalseMergePairs ?? []) {
      const predictedLeft = assignments.get(left);
      const predictedRight = assignments.get(right);
      if (!predictedLeft || !predictedRight) throw new Error(`Missing dangerous pair in ${benchmarkCase.id}`);
      if (
        predictedLeft.delivery_key === predictedRight.delivery_key ||
        predictedLeft.conversation_id === predictedRight.conversation_id
      ) {
        dangerousFalseMerges += 1;
      }
    }
  }

  return {
    delivery: score(delivery),
    conversation: score(conversation),
    dangerousFalseMerges,
    cases: cases.length,
    messages,
    slices: [...new Set(cases.map((benchmarkCase) => benchmarkCase.slice))].sort()
  };
}
