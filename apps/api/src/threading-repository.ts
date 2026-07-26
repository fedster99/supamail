import { createHash } from "node:crypto";
import type { PgClient, PgPool } from "./db.js";
import {
  THREADING_ALGORITHM_VERSION,
  computeThreadAssignments,
  computeThreadAssignmentsV1,
  computeThreadAssignmentsV2,
  deliveryClosureFingerprints,
  type ThreadingAssignment,
  type ThreadingMessageInput,
  type ThreadingOptions
} from "./threading.js";

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_BODY_EVIDENCE_BATCH_SIZE = 2;
const DEFAULT_BODY_EVIDENCE_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CLOSURE_MESSAGES = 25_000;
const DEFAULT_MAX_CLOSURE_EVIDENCE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CLOSURE_CRITERIA_KEYS = 100_000;
const DEFAULT_MAX_SUBJECT_BUCKET_MESSAGES = 5_000;
const WRITE_CHUNK_SIZE = 1_000;
const LIVE_RUN_STATUSES = ["building", "ready", "active", "standby"] as const;
const DEFAULT_COMPARISON_STATEMENT_TIMEOUT_MS = 30_000;
const RUN_FAIRNESS_SCHEDULE = ["active", "active", "standby", "active", "building"] as const;
const DELIVERY_EVIDENCE_BRIDGE_REASON = "delivery_evidence_bridge";

type RunStatus = "building" | "ready" | "active" | "standby" | "archived" | "failed" | "rolled_back";
type RunStage = "body_evidence" | "strong" | "subject" | "catchup" | "ready";
type RunMode = "initial" | "upgrade" | "rebuild";
type OperationType = "build_batch" | "incremental" | "activate" | "rollback" | "failure";

interface ThreadState {
  account_id: string;
  active_run_id: string | null;
  previous_run_id: string | null;
  building_run_id: string | null;
  scheduler_cursor: number;
  paused_at: Date | null;
  pause_reason: string | null;
}

interface ThreadRun {
  id: string;
  account_id: string;
  algorithm_version: number;
  mode: RunMode;
  status: RunStatus;
  stage: RunStage;
  source_run_id: string | null;
  cursor_folder_path: string | null;
  cursor_uidvalidity: string | null;
  cursor_uid: string | null;
  cursor_message_id: string | null;
  attempts: number;
  available_at: Date;
  caught_up_revision: string;
  summary: Record<string, unknown>;
}

type ScheduledRunRole = typeof RUN_FAIRNESS_SCHEDULE[number];

function selectFairRun(
  cursor: number,
  runs: Record<ScheduledRunRole, ThreadRun | null>
): { run: ThreadRun; nextCursor: number } | null {
  const start = Number.isSafeInteger(cursor)
    ? ((cursor % RUN_FAIRNESS_SCHEDULE.length) + RUN_FAIRNESS_SCHEDULE.length) % RUN_FAIRNESS_SCHEDULE.length
    : 0;
  for (let offset = 0; offset < RUN_FAIRNESS_SCHEDULE.length; offset += 1) {
    const index = (start + offset) % RUN_FAIRNESS_SCHEDULE.length;
    const run = runs[RUN_FAIRNESS_SCHEDULE[index]];
    if (run) return { run, nextCursor: (index + 1) % RUN_FAIRNESS_SCHEDULE.length };
  }
  return null;
}

interface PhysicalPageRow {
  id: string;
  folder_path: string;
  uidvalidity: string;
  uid: string;
}

interface StoredAssignment {
  run_id: string;
  message_id: string;
  account_id: string;
  delivery_key: string;
  strict_message_id: string | null;
  strict_message_id_hash: string | null;
  conversation_id: string;
  root_reference: string | null;
  root_reference_hash: string | null;
  parent_reference: string | null;
  parent_reference_hash: string | null;
  parent_delivery_key: string | null;
  reference_ids: string[];
  reference_hashes: string[];
  delivery_fingerprint_hashes: string[];
  subject_base: string | null;
  subject_key: string | null;
  participant_edge_hashes: string[];
  provider_thread_key: string | null;
  provider_thread_hash: string | null;
  assignment_method: ThreadingAssignment["method"];
  confidence: ThreadingAssignment["confidence"];
  is_provisional: boolean;
  subject_fallback_eligible: boolean;
  algorithm_version: number;
  input_hash: string;
  generation: string;
  evidence: Record<string, unknown>;
}

interface AssignmentRecord extends StoredAssignment {}

interface ThreadingCriteria {
  conversationIds: Set<string>;
  deliveryKeys: Set<string>;
  referenceHashes: Set<string>;
  deliveryFingerprintHashes: Set<string>;
  providerThreadHashes: Set<string>;
}

function deliveryEvidenceBridgeIds(
  assignments: readonly ThreadingAssignment[],
  inputs: readonly ThreadingMessageInput[]
): string[] {
  const inputsById = new Map(inputs.map((input) => [input.id, input]));
  const groups = new Map<string, ThreadingAssignment[]>();
  for (const assignment of assignments) {
    if (!assignment.strict_message_id) continue;
    const group = groups.get(assignment.strict_message_id) ?? [];
    group.push(assignment);
    groups.set(assignment.strict_message_id, group);
  }

  const ids = new Set<string>();
  for (const group of groups.values()) {
    const deliveryKeys = new Set(group.map((assignment) => assignment.delivery_key));
    const metadataMatchNeedsCorroboration = group.some((assignment) =>
      assignment.evidence.parse_warnings.includes("delivery_metadata_fingerprint_match")
    );
    if (deliveryKeys.size < 2 && !metadataMatchNeedsCorroboration) continue;
    for (const assignment of group) {
      const input = inputsById.get(assignment.physical_message_id);
      if (!input || input.authored_delivery_fingerprint) continue;
      ids.add(assignment.physical_message_id);
    }
  }
  return [...ids].sort(compareText);
}

interface ClosureLimits {
  maxMessages: number;
  maxEvidenceBytes: number;
  maxCriteriaKeys: number;
}

type AttemptedThreadWork = (ids: string[], canSubdivide: boolean) => void;

function adaptiveClosureBatchSize(run: ThreadRun, requestedBatchSize: number): number {
  const stored = run.summary.adaptive_closure_batch_size;
  const parsed = typeof stored === "number" ? stored : Number(stored);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(requestedBatchSize, parsed)
    : requestedBatchSize;
}

export interface ThreadingRunResult {
  accountId: string;
  runId: string | null;
  runStatus: RunStatus | null;
  stage: RunStage | null;
  operationId: string | null;
  operationType: OperationType | null;
  generation: string | null;
  messagesConsidered: number;
  assignmentsChanged: number;
  queueItemsProcessed: number;
  subjectFallbackEnabled: boolean;
  busy: boolean;
  ready: boolean;
  active: boolean;
}

export interface ThreadingRunComparisonSample {
  messageId: string;
  baselineConversationId: string | null;
  candidateConversationId: string | null;
  baselineDeliveryKey: string | null;
  candidateDeliveryKey: string | null;
  baselineMethod: ThreadingAssignment["method"] | null;
  candidateMethod: ThreadingAssignment["method"] | null;
  baselineProvisional: boolean | null;
  candidateProvisional: boolean | null;
}

export interface ThreadingRunComparison {
  comparisonId: string;
  accountId: string;
  baselineRunId: string;
  candidateRunId: string;
  baselineAlgorithmVersion: number;
  candidateAlgorithmVersion: number;
  baselineGeneration: string;
  candidateGeneration: string;
  evidenceRevision: string;
  passed: boolean;
  thresholds: ThreadingComparisonThresholds;
  baselineAssignments: number;
  candidateAssignments: number;
  unchangedAssignments: number;
  changedAssignments: number;
  onlyBaselineAssignments: number;
  onlyCandidateAssignments: number;
  baselineDeliveries: number;
  candidateDeliveries: number;
  baselineConversations: number;
  candidateConversations: number;
  conversationSplits: { groups: number; messages: number };
  conversationMerges: { groups: number; messages: number };
  provisionalBefore: number;
  provisionalAfter: number;
  provisionalResolved: number;
  provisionalIntroduced: number;
  baselineMethods: Record<string, number>;
  candidateMethods: Record<string, number>;
  samples: ThreadingRunComparisonSample[];
}

export interface DrainThreadingOptions {
  batchSize?: number;
  maxClosureMessages?: number;
  maxClosureEvidenceBytes?: number;
  maxClosureCriteriaKeys?: number;
  maxSubjectBucketMessages?: number;
  requestedBy?: string;
  /** Activate only a completed first projection. Upgrades and rebuilds still
   * require the normal reviewed comparison-certificate workflow. */
  activateInitial?: boolean;
}

export interface RebuildThreadingOptions extends DrainThreadingOptions {
  reason?: string;
  activate?: boolean;
}

export interface ActivateThreadingOptions {
  requestedBy?: string;
  reason?: string;
  /** Required when replacing an existing active run. */
  comparisonId?: string;
}

export interface ThreadingComparisonThresholds {
  maxConversationMergeGroups: number;
  maxConversationSplitGroups: number;
  maxProvisionalIntroduced: number;
  maxOnlyBaselineAssignments: number;
  maxOnlyCandidateAssignments: number;
}

export interface CompareThreadingOptions {
  requestedBy?: string;
  statementTimeoutMs?: number;
  thresholds?: Partial<ThreadingComparisonThresholds>;
}

export type ThreadingAlgorithmExecutor = (
  messages: readonly ThreadingMessageInput[],
  options?: ThreadingOptions
) => ThreadingAssignment[];

/**
 * Production executors are intentionally keyed by a literal version. When the
 * current version advances, startup fails until the new executor is added here;
 * the prior executor must remain until no active/candidate/standby run uses it.
 */
export const PRODUCTION_THREADING_ALGORITHMS: ReadonlyMap<number, ThreadingAlgorithmExecutor> = new Map([
  [1, computeThreadAssignmentsV1],
  [2, computeThreadAssignmentsV2],
  [3, computeThreadAssignments]
]);

export interface ThreadingRepositoryOptions {
  /** Version used for newly-created shadow runs and activation. */
  currentAlgorithmVersion?: number;
  /** Legacy body fingerprints are expensive and must not inherit the much larger projection batch. */
  bodyEvidenceBatchSize?: number;
  /** Server-side deadline for one legacy fingerprint repair transaction. */
  bodyEvidenceStatementTimeoutMs?: number;
  /**
   * Every executor still needed by an active or rollback run. A new release
   * must retain the previous executor until its standby retention window ends.
   */
  algorithms?: ReadonlyMap<number, ThreadingAlgorithmExecutor>;
}

export class ThreadingClosureLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Threading closure exceeded the safety limit of ${limit} messages`);
    this.name = "ThreadingClosureLimitError";
  }
}

export class ThreadingEvidenceLimitError extends Error {
  constructor(readonly kind: "bytes" | "criteria", readonly limit: number) {
    super(`Threading closure exceeded the safety limit of ${limit} ${kind === "bytes" ? "evidence bytes" : "criteria keys"}`);
    this.name = "ThreadingEvidenceLimitError";
  }
}

export class ThreadingVersionSkewError extends Error {
  constructor(
    readonly storedVersion: number,
    supportedVersions: readonly number[] = [THREADING_ALGORITHM_VERSION],
    message?: string
  ) {
    super(
      message ?? `Threading run uses algorithm v${storedVersion}, but this worker supports ${
        supportedVersions.map((version) => `v${version}`).join(", ") || "no versions"
      }`
    );
    this.name = "ThreadingVersionSkewError";
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceHash(namespace: string, value: string | null | undefined): string | null {
  return value ? sha256(`${namespace}\u0000${value}`) : null;
}

function persistedDeliveryKey(value: string): string {
  return sha256(`delivery\u0000${value}`);
}

function persistedParentDeliveryKey(value: string | null): string | null {
  return value ? persistedDeliveryKey(value) : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeParticipant(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return trimmed;
  return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
}

function isAutomatedInput(input: ThreadingMessageInput): boolean {
  const header = (name: string): string[] => {
    const values: string[] = [];
    for (const [key, value] of Object.entries(input.headers_json ?? {})) {
      if (key.toLowerCase() !== name) continue;
      if (typeof value === "string") values.push(value);
      else if (Array.isArray(value)) {
        for (const entry of value) if (typeof entry === "string") values.push(entry);
      }
    }
    return values;
  };
  const auto = (input.auto_submitted ?? header("auto-submitted")[0])?.trim().toLowerCase();
  if (auto && auto !== "no") return true;
  const precedence = (input.precedence ?? header("precedence")[0])?.trim().toLowerCase();
  if (precedence && /(?:^|\s|,)(?:bulk|list|junk)(?:$|\s|,)/.test(precedence)) return true;
  return Boolean(
    input.list_id ?? header("list-id")[0] ??
    input.list_unsubscribe ?? header("list-unsubscribe")[0] ??
    input.x_auto_response_suppress ?? header("x-auto-response-suppress")[0]
  );
}

function isSubjectFallbackCandidate(
  assignment: ThreadingAssignment,
  inputsById: ReadonlyMap<string, ThreadingMessageInput>
): boolean {
  if (!assignment.subject_base || assignment.reference_ids.length > 0) return false;
  if (assignment.method !== "standalone" && assignment.method !== "subject_fallback") return false;
  if (assignment.evidence.parse_warnings.some((warning) =>
    warning.startsWith("malformed_") ||
    warning.startsWith("oversized_") ||
    warning.startsWith("delivery_copies_disagree_") ||
    warning === "ambiguous_message_id_owner"
  )) return false;

  let hasParticipantEdge = false;
  for (const id of assignment.evidence.collapsed_physical_ids) {
    const input = inputsById.get(id);
    if (!input || isAutomatedInput(input)) return false;
    const subject = input.subject?.normalize("NFKC").replace(/\s+/g, " ").trim() ?? "";
    if (/^(?:\[[^\]]{1,80}\]\s*)?(?:fw|fwd)\s*:/i.test(subject) ||
        /^\[fwd:/i.test(subject) || /\(fwd\)\s*$/i.test(subject)) return false;
    if (input.from_email && [...(input.to_emails ?? []), ...(input.cc_emails ?? []), ...(input.bcc_emails ?? [])].length > 0) {
      hasParticipantEdge = true;
    }
  }
  return hasParticipantEdge;
}

function participantEdges(
  assignment: ThreadingAssignment,
  inputsById: ReadonlyMap<string, ThreadingMessageInput>
): string[] {
  const edges = new Set<string>();
  for (const id of assignment.evidence.collapsed_physical_ids) {
    const input = inputsById.get(id);
    if (!input) continue;
    const from = normalizeParticipant(input.from_email);
    if (!from) continue;
    for (const raw of [...(input.to_emails ?? []), ...(input.cc_emails ?? []), ...(input.bcc_emails ?? [])]) {
      const recipient = normalizeParticipant(raw);
      if (recipient) edges.add(sha256(`participant-edge\u0000${from}\u0000${recipient}`));
    }
  }
  return [...edges].sort(compareText);
}

function deliveryFingerprintHashes(
  assignment: ThreadingAssignment,
  inputsById: ReadonlyMap<string, ThreadingMessageInput>,
  algorithmVersion: number
): string[] {
  const input = inputsById.get(assignment.physical_message_id);
  if (!input) return [];
  return deliveryClosureFingerprints(input, algorithmVersion)
    .map((fingerprint) => sha256(`delivery-fingerprint\u0000${fingerprint}`))
    .sort(compareText);
}

function addInputCriteria(
  criteria: ThreadingCriteria,
  input: ThreadingMessageInput,
  algorithmVersion: number
): void {
  for (const fingerprint of deliveryClosureFingerprints(input, algorithmVersion)) {
    criteria.deliveryFingerprintHashes.add(sha256(`delivery-fingerprint\u0000${fingerprint}`));
  }
}

function emptyCriteria(): ThreadingCriteria {
  return {
    conversationIds: new Set(),
    deliveryKeys: new Set(),
    referenceHashes: new Set(),
    deliveryFingerprintHashes: new Set(),
    providerThreadHashes: new Set()
  };
}

function addValue(target: Set<string>, value: string | null | undefined): void {
  if (value) target.add(value);
}

function addStoredCriteria(criteria: ThreadingCriteria, assignment: StoredAssignment): void {
  addValue(criteria.conversationIds, assignment.conversation_id);
  addValue(criteria.deliveryKeys, assignment.delivery_key);
  addValue(criteria.referenceHashes, assignment.strict_message_id_hash);
  addValue(criteria.referenceHashes, assignment.root_reference_hash);
  addValue(criteria.referenceHashes, assignment.parent_reference_hash);
  for (const reference of assignment.reference_hashes) addValue(criteria.referenceHashes, reference);
  for (const fingerprint of assignment.delivery_fingerprint_hashes) {
    addValue(criteria.deliveryFingerprintHashes, fingerprint);
  }
  addValue(criteria.providerThreadHashes, assignment.provider_thread_hash);
}

function addComputedCriteria(criteria: ThreadingCriteria, assignment: ThreadingAssignment): void {
  addValue(criteria.conversationIds, assignment.conversation_id);
  addValue(criteria.deliveryKeys, persistedDeliveryKey(assignment.delivery_key));
  addValue(criteria.referenceHashes, evidenceHash("message-id", assignment.strict_message_id));
  addValue(criteria.referenceHashes, evidenceHash("message-id", assignment.root_reference));
  addValue(criteria.referenceHashes, evidenceHash("message-id", assignment.parent_reference));
  for (const reference of assignment.reference_ids) {
    addValue(criteria.referenceHashes, evidenceHash("message-id", reference));
  }
  addValue(criteria.providerThreadHashes, evidenceHash("provider-thread", assignment.provider_thread_key));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareText(a, b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function withoutGeneration(value: StoredAssignment): Omit<StoredAssignment, "generation"> {
  const { generation: _generation, ...rest } = value;
  return rest;
}

function sameAssignment(current: StoredAssignment | undefined, next: AssignmentRecord): boolean {
  return Boolean(current) && canonicalJson(withoutGeneration(current as StoredAssignment)) ===
    canonicalJson(withoutGeneration(next));
}

function assignmentRecord(
  run: ThreadRun,
  assignment: ThreadingAssignment,
  generation: string,
  inputsById: ReadonlyMap<string, ThreadingMessageInput>
): AssignmentRecord {
  const subjectKey = evidenceHash("subject", assignment.subject_base);
  return {
    run_id: run.id,
    message_id: assignment.physical_message_id,
    account_id: assignment.account_id,
    delivery_key: persistedDeliveryKey(assignment.delivery_key),
    strict_message_id: assignment.strict_message_id,
    strict_message_id_hash: evidenceHash("message-id", assignment.strict_message_id),
    conversation_id: assignment.conversation_id,
    root_reference: assignment.root_reference,
    root_reference_hash: evidenceHash("message-id", assignment.root_reference),
    parent_reference: assignment.parent_reference,
    parent_reference_hash: evidenceHash("message-id", assignment.parent_reference),
    parent_delivery_key: persistedParentDeliveryKey(assignment.parent_delivery_key),
    reference_ids: [...assignment.reference_ids],
    reference_hashes: assignment.reference_ids
      .map((reference) => evidenceHash("message-id", reference) as string)
      .sort(compareText),
    delivery_fingerprint_hashes: deliveryFingerprintHashes(assignment, inputsById, run.algorithm_version),
    subject_base: assignment.subject_base,
    subject_key: subjectKey,
    participant_edge_hashes: participantEdges(assignment, inputsById),
    provider_thread_key: assignment.provider_thread_key,
    provider_thread_hash: evidenceHash("provider-thread", assignment.provider_thread_key),
    assignment_method: assignment.method,
    confidence: assignment.confidence,
    is_provisional: assignment.provisional,
    subject_fallback_eligible: isSubjectFallbackCandidate(assignment, inputsById),
    algorithm_version: assignment.algorithm_version,
    input_hash: assignment.input_hash,
    generation,
    evidence: {
      ...assignment.evidence,
      conversation_anchor: assignment.conversation_anchor
    }
  };
}

function snapshot(value: StoredAssignment): Record<string, unknown> {
  return {
    run_id: value.run_id,
    message_id: value.message_id,
    account_id: value.account_id,
    delivery_key: value.delivery_key,
    strict_message_id: value.strict_message_id,
    strict_message_id_hash: value.strict_message_id_hash,
    conversation_id: value.conversation_id,
    root_reference: value.root_reference,
    root_reference_hash: value.root_reference_hash,
    parent_reference: value.parent_reference,
    parent_reference_hash: value.parent_reference_hash,
    parent_delivery_key: value.parent_delivery_key,
    reference_ids: [...value.reference_ids],
    reference_hashes: [...value.reference_hashes],
    delivery_fingerprint_hashes: [...value.delivery_fingerprint_hashes],
    subject_base: value.subject_base,
    subject_key: value.subject_key,
    participant_edge_hashes: [...value.participant_edge_hashes],
    provider_thread_key: value.provider_thread_key,
    provider_thread_hash: value.provider_thread_hash,
    assignment_method: value.assignment_method,
    confidence: value.confidence,
    is_provisional: value.is_provisional,
    subject_fallback_eligible: value.subject_fallback_eligible,
    algorithm_version: value.algorithm_version,
    input_hash: value.input_hash,
    generation: value.generation,
    evidence: value.evidence
  };
}

function restoreSnapshot(value: Record<string, unknown>, generation: string): AssignmentRecord {
  const strings = (entry: unknown): string[] => Array.isArray(entry) ? entry.map(String) : [];
  const nullable = (entry: unknown): string | null => entry == null ? null : String(entry);
  return {
    run_id: String(value.run_id),
    message_id: String(value.message_id),
    account_id: String(value.account_id),
    delivery_key: String(value.delivery_key),
    strict_message_id: nullable(value.strict_message_id),
    strict_message_id_hash: nullable(value.strict_message_id_hash),
    conversation_id: String(value.conversation_id),
    root_reference: nullable(value.root_reference),
    root_reference_hash: nullable(value.root_reference_hash),
    parent_reference: nullable(value.parent_reference),
    parent_reference_hash: nullable(value.parent_reference_hash),
    parent_delivery_key: nullable(value.parent_delivery_key),
    reference_ids: strings(value.reference_ids),
    reference_hashes: strings(value.reference_hashes),
    delivery_fingerprint_hashes: strings(value.delivery_fingerprint_hashes),
    subject_base: nullable(value.subject_base),
    subject_key: nullable(value.subject_key),
    participant_edge_hashes: strings(value.participant_edge_hashes),
    provider_thread_key: nullable(value.provider_thread_key),
    provider_thread_hash: nullable(value.provider_thread_hash),
    assignment_method: value.assignment_method as ThreadingAssignment["method"],
    confidence: value.confidence as ThreadingAssignment["confidence"],
    is_provisional: Boolean(value.is_provisional),
    subject_fallback_eligible: Boolean(value.subject_fallback_eligible),
    algorithm_version: Number(value.algorithm_version),
    input_hash: String(value.input_hash),
    generation,
    evidence: value.evidence && typeof value.evidence === "object"
      ? value.evidence as Record<string, unknown>
      : {}
  };
}

function chunk<T>(values: readonly T[], size = WRITE_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function sanitizedFailure(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\x00-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function boundedNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error("threading comparison thresholds must be finite numbers");
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)));
}

function comparisonThresholds(
  input: Partial<ThreadingComparisonThresholds> | undefined
): ThreadingComparisonThresholds {
  return {
    maxConversationMergeGroups: boundedNonNegativeInteger(input?.maxConversationMergeGroups, 0),
    maxConversationSplitGroups: boundedNonNegativeInteger(input?.maxConversationSplitGroups, 0),
    maxProvisionalIntroduced: boundedNonNegativeInteger(input?.maxProvisionalIntroduced, 0),
    maxOnlyBaselineAssignments: boundedNonNegativeInteger(input?.maxOnlyBaselineAssignments, 0),
    maxOnlyCandidateAssignments: boundedNonNegativeInteger(input?.maxOnlyCandidateAssignments, 0)
  };
}

function cursorFrom(
  row: PhysicalPageRow
): Pick<ThreadRun, "cursor_folder_path" | "cursor_uidvalidity" | "cursor_uid" | "cursor_message_id"> {
  return {
    cursor_folder_path: null,
    cursor_uidvalidity: null,
    cursor_uid: null,
    cursor_message_id: row.id
  };
}

/** Versioned, account-scoped orchestration around the pure threading algorithm. */
export class ThreadingRepository {
  private readonly currentAlgorithmVersion: number;
  private readonly algorithms: ReadonlyMap<number, ThreadingAlgorithmExecutor>;
  private readonly bodyEvidenceBatchSize: number;
  private readonly bodyEvidenceStatementTimeoutMs: number;

  constructor(private readonly pool: PgPool, options: ThreadingRepositoryOptions = {}) {
    this.currentAlgorithmVersion = options.currentAlgorithmVersion ?? THREADING_ALGORITHM_VERSION;
    if (!Number.isSafeInteger(this.currentAlgorithmVersion) || this.currentAlgorithmVersion <= 0) {
      throw new Error("current threading algorithm version must be a positive safe integer");
    }
    this.bodyEvidenceBatchSize = options.bodyEvidenceBatchSize ?? DEFAULT_BODY_EVIDENCE_BATCH_SIZE;
    if (!Number.isSafeInteger(this.bodyEvidenceBatchSize) || this.bodyEvidenceBatchSize <= 0) {
      throw new Error("threading body evidence batch size must be a positive safe integer");
    }
    this.bodyEvidenceStatementTimeoutMs = options.bodyEvidenceStatementTimeoutMs
      ?? DEFAULT_BODY_EVIDENCE_STATEMENT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.bodyEvidenceStatementTimeoutMs) || this.bodyEvidenceStatementTimeoutMs <= 0) {
      throw new Error("threading body evidence statement timeout must be a positive safe integer");
    }
    this.algorithms = options.algorithms ?? PRODUCTION_THREADING_ALGORITHMS;
    if (!this.algorithms.has(this.currentAlgorithmVersion)) {
      throw new Error(`missing executor for current threading algorithm v${this.currentAlgorithmVersion}`);
    }
    for (const version of this.algorithms.keys()) {
      if (!Number.isSafeInteger(version) || version <= 0) {
        throw new Error("threading executor versions must be positive safe integers");
      }
      if (version > this.currentAlgorithmVersion) {
        throw new Error(`threading executor v${version} is newer than current v${this.currentAlgorithmVersion}`);
      }
    }
  }

  /** Fail deployment before a state-referenced run can be silently abandoned. */
  async assertRolloutCompatibility(): Promise<void> {
    const unsupported = await this.pool.query<{
      account_id: string;
      role: "active" | "candidate" | "standby";
      run_id: string;
      algorithm_version: number;
    }>(
      `SELECT state.account_id, reference.role, run.id AS run_id, run.algorithm_version
       FROM public.imap_thread_state state
       CROSS JOIN LATERAL (VALUES
         ('active'::text, state.active_run_id),
         ('candidate'::text, state.building_run_id),
         ('standby'::text, state.previous_run_id)
       ) AS reference(role, run_id)
       JOIN public.imap_thread_runs run ON run.id = reference.run_id
       WHERE (
         (reference.role = 'active' AND run.status = 'active')
         OR (reference.role = 'candidate' AND run.status IN ('building', 'ready'))
         OR (reference.role = 'standby' AND run.status = 'standby')
       )
         AND NOT (run.algorithm_version = ANY($1::integer[]))
       ORDER BY state.account_id, reference.role, run.id
       LIMIT 1`,
      [[...this.algorithms.keys()]]
    );
    const run = unsupported.rows[0];
    if (!run) return;
    throw this.missingExecutor(run.role, run.run_id, run.algorithm_version, run.account_id);
  }

  async listAccountsNeedingWork(
    limit = 10,
    options: Pick<DrainThreadingOptions, "activateInitial"> = {}
  ): Promise<string[]> {
    await this.assertRolloutCompatibility();
    const bounded = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 10, 1_000));
    const result = await this.pool.query<{ account_id: string }>(
      `
      SELECT account.id AS account_id
      FROM public.imap_accounts account
      LEFT JOIN public.imap_thread_state state ON state.account_id = account.id
      LEFT JOIN public.imap_thread_runs active ON active.id = state.active_run_id
      LEFT JOIN public.imap_thread_runs building ON building.id = state.building_run_id
      LEFT JOIN public.imap_thread_runs standby ON standby.id = state.previous_run_id
      WHERE state.paused_at IS NULL
        AND (
          state.account_id IS NULL
          OR (
            building.id IS NULL
            AND (active.id IS NULL OR active.algorithm_version < $2)
          )
          OR (
            building.id IS NOT NULL
            AND building.algorithm_version <= $2
            AND building.status NOT IN ('building', 'ready')
          )
          OR (
            building.algorithm_version < $2
          )
          OR (
            building.algorithm_version = ANY($3::integer[])
            AND building.available_at <= now()
            AND (
              (
                building.status = 'building'
                AND (
                  building.stage IN ('body_evidence', 'strong')
                  OR (
                    building.stage = 'subject'
                    AND (
                      EXISTS (
                        SELECT 1 FROM public.imap_thread_subject_work sw
                        WHERE sw.run_id = building.id AND sw.available_at <= now()
                      )
                      OR NOT EXISTS (
                        SELECT 1 FROM public.imap_thread_subject_work sw
                        WHERE sw.run_id = building.id
                      )
                    )
                  )
                  OR (
                    building.stage = 'catchup'
                    AND (
                      EXISTS (
                        SELECT 1 FROM public.imap_thread_work_queue q
                        WHERE q.run_id = building.id AND q.available_at <= now()
                      )
                      OR EXISTS (
                        SELECT 1 FROM public.imap_thread_subject_work sw
                        WHERE sw.run_id = building.id AND sw.available_at <= now()
                      )
                      OR (
                        NOT EXISTS (
                          SELECT 1 FROM public.imap_thread_work_queue q
                          WHERE q.run_id = building.id
                        )
                        AND NOT EXISTS (
                          SELECT 1 FROM public.imap_thread_subject_work sw
                          WHERE sw.run_id = building.id
                        )
                      )
                    )
                  )
                )
              )
              OR (
                building.status = 'ready'
                AND (
                  EXISTS (
                    SELECT 1 FROM public.imap_thread_work_queue q
                    WHERE q.run_id = building.id AND q.available_at <= now()
                  )
                  OR EXISTS (
                    SELECT 1 FROM public.imap_thread_subject_work sw
                    WHERE sw.run_id = building.id AND sw.available_at <= now()
                  )
                  OR building.summary->>'coverage_verified' IS DISTINCT FROM 'true'
                  OR (
                    $4::boolean
                    AND active.id IS NULL
                    AND building.mode = 'initial'
                  )
                )
              )
            )
          )
          OR (
            active.algorithm_version = ANY($3::integer[])
            AND active.available_at <= now()
            AND (
              EXISTS (
                SELECT 1 FROM public.imap_thread_work_queue q
                WHERE q.run_id = active.id AND q.available_at <= now()
              )
              OR EXISTS (
                SELECT 1 FROM public.imap_thread_subject_work sw
                WHERE sw.run_id = active.id AND sw.available_at <= now()
              )
            )
          )
          OR (
            standby.status = 'standby'
            AND standby.algorithm_version = ANY($3::integer[])
            AND standby.available_at <= now()
            AND (
              EXISTS (
                SELECT 1 FROM public.imap_thread_work_queue q
                WHERE q.run_id = standby.id AND q.available_at <= now()
              )
              OR EXISTS (
                SELECT 1 FROM public.imap_thread_subject_work sw
                WHERE sw.run_id = standby.id AND sw.available_at <= now()
              )
            )
          )
        )
      ORDER BY account.updated_at, account.id
      LIMIT $1
      `,
      [
        bounded,
        this.currentAlgorithmVersion,
        [...this.algorithms.keys()],
        options.activateInitial === true
      ]
    );
    return result.rows.map((row) => row.account_id);
  }

  async drainAccount(accountId: string, options: DrainThreadingOptions = {}): Promise<ThreadingRunResult> {
    const batchSize = Math.max(1, Math.min(
      Number.isFinite(options.batchSize) ? Math.floor(Number(options.batchSize)) : DEFAULT_BATCH_SIZE,
      10_000
    ));
    const maxClosureMessages = Math.max(batchSize, Math.min(
      Number.isFinite(options.maxClosureMessages)
        ? Math.floor(Number(options.maxClosureMessages))
        : DEFAULT_MAX_CLOSURE_MESSAGES,
      250_000
    ));
    const maxClosureEvidenceBytes = Math.max(1_024, Math.min(
      Number.isFinite(options.maxClosureEvidenceBytes)
        ? Math.floor(Number(options.maxClosureEvidenceBytes))
        : DEFAULT_MAX_CLOSURE_EVIDENCE_BYTES,
      512 * 1024 * 1024
    ));
    const maxClosureCriteriaKeys = Math.max(1_000, Math.min(
      Number.isFinite(options.maxClosureCriteriaKeys)
        ? Math.floor(Number(options.maxClosureCriteriaKeys))
        : DEFAULT_MAX_CLOSURE_CRITERIA_KEYS,
      1_000_000
    ));
    const closureLimits: ClosureLimits = {
      maxMessages: maxClosureMessages,
      maxEvidenceBytes: maxClosureEvidenceBytes,
      maxCriteriaKeys: maxClosureCriteriaKeys
    };
    const maxSubjectBucketMessages = Math.max(2, Math.min(
      Number.isFinite(options.maxSubjectBucketMessages)
        ? Math.floor(Number(options.maxSubjectBucketMessages))
        : DEFAULT_MAX_SUBJECT_BUCKET_MESSAGES,
      maxClosureMessages
    ));
    let failedRun: ThreadRun | null = null;
    let attemptedIds: string[] = [];
    let attemptedCanSubdivide = false;

    const result = await this.withAccountLock(accountId, async (client) => {
        // This pass deliberately runs before the thread-state transaction. A
        // pre-upgrade mirror writer locks imap_message_bodies before its AFTER
        // trigger takes the state SHARE lock; taking state FOR UPDATE first and
        // then hashing that same row would invert the lock order and deadlock.
        // The update is bounded, idempotent, and its evidence trigger queues all
        // live runs before the projection transaction begins.
        const bodyEvidenceBatchSize = Math.min(batchSize, this.bodyEvidenceBatchSize);
        const bodyHashesBackfilled = await this.backfillBodyEvidenceBatchWithinDeadline(
          client,
          accountId,
          bodyEvidenceBatchSize
        );
        // A full page may have more eligible bodies behind it. Leave every
        // projection queue untouched until a shorter page proves this bounded
        // preflight has reached the end of the current backlog.
        if (bodyHashesBackfilled === bodyEvidenceBatchSize) return this.emptyResult(accountId);

        // READ COMMITTED is required after waiting for a legacy writer's SHARE
        // lock: the gap check below must see the queue/body row that writer just
        // committed. Once state is locked, evidence triggers cannot commit until
        // this bounded projection transaction finishes.
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        try {
          const state = await this.lockState(client, accountId);
          if (await this.hasQueuedBodyEvidenceGap(client, accountId)) {
            await client.query("COMMIT");
            return this.emptyResult(accountId);
          }
          let active = state.active_run_id ? await this.loadRun(client, state.active_run_id) : null;
          let building = state.building_run_id ? await this.loadRun(client, state.building_run_id) : null;
          const standby = state.previous_run_id ? await this.loadRun(client, state.previous_run_id) : null;
          this.requireExecutor(active, "active");
          this.requireExecutor(building, "candidate");
          this.requireExecutor(standby, "standby");

          if (
            building &&
            building.algorithm_version <= this.currentAlgorithmVersion &&
            building.status !== "building" &&
            building.status !== "ready"
          ) {
            await client.query(
              "UPDATE public.imap_thread_state SET building_run_id = NULL WHERE account_id = $1",
              [accountId]
            );
            await this.clearRunWork(client, building.id);
            building = null;
          }

          if (building && building.algorithm_version < this.currentAlgorithmVersion) {
            await client.query(
              `UPDATE public.imap_thread_runs
               SET status = 'failed', last_error = 'superseded by a newer algorithm build', completed_at = now()
               WHERE id = $1`,
              [building.id]
            );
            await client.query(
              "UPDATE public.imap_thread_state SET building_run_id = NULL WHERE account_id = $1",
              [accountId]
            );
            await this.clearRunWork(client, building.id);
            building = null;
          }

          if (!building && (!active || active.algorithm_version < this.currentAlgorithmVersion)) {
            building = await this.createBuildRun(
              client,
              state,
              active,
              active ? "upgrade" : "initial",
              options.requestedBy ?? "thread-worker",
              active ? `algorithm upgrade to v${this.currentAlgorithmVersion}` : "initial conversation build"
            );
          }

          const activeHasReadyWork = !state.paused_at && active && this.algorithms.has(active.algorithm_version)
            ? await this.runHasReadyWork(client, active.id)
            : false;
          const standbyHasReadyWork = !state.paused_at &&
            standby?.status === "standby" &&
            this.algorithms.has(standby.algorithm_version)
            ? await this.runHasReadyWork(client, standby.id)
            : false;
          const compatibleBuilding = building &&
            building.algorithm_version === this.currentAlgorithmVersion &&
            this.algorithms.has(building.algorithm_version)
            ? building
            : null;
          const scheduled = selectFairRun(state.scheduler_cursor, {
            active: activeHasReadyWork ? active : null,
            standby: standbyHasReadyWork ? standby : null,
            building: compatibleBuilding
          });
          let run = scheduled?.run ?? null;
          if (scheduled) {
            await client.query(
              "UPDATE public.imap_thread_state SET scheduler_cursor = $2 WHERE account_id = $1",
              [accountId, scheduled.nextCursor]
            );
          }
          if (!run && !state.paused_at && active && this.algorithms.has(active.algorithm_version)) run = active;
          if (!run) {
            const unsupportedNewer = [active, building].find(
              (candidate) => candidate && candidate.algorithm_version > this.currentAlgorithmVersion
            );
            if (unsupportedNewer) {
              throw this.versionSkew(unsupportedNewer.algorithm_version);
            }
            await client.query("COMMIT");
            return this.emptyResult(accountId);
          }
          failedRun = run;
          const closureBatchSize = adaptiveClosureBatchSize(run, batchSize);
          const attempted: AttemptedThreadWork = (ids, canSubdivide) => {
            attemptedIds = ids;
            attemptedCanSubdivide = canSubdivide;
          };
          if (run.available_at > new Date()) {
            await client.query("COMMIT");
            return this.resultForRun(accountId, run, { busy: true });
          }

          let processed: ThreadingRunResult;
          if (run.status === "active" || run.status === "ready" || run.status === "standby") {
            processed = await this.processLiveRun(
              client,
              run,
              closureBatchSize,
              closureLimits,
              maxSubjectBucketMessages,
              options.requestedBy ?? "thread-worker",
              attempted
            );
          } else if (run.stage === "body_evidence") {
            processed = await this.processBodyEvidencePage(
              client,
              run,
              batchSize,
              bodyHashesBackfilled,
              options.requestedBy ?? "thread-worker"
            );
          } else if (run.stage === "strong") {
            processed = await this.processStrongPage(
              client,
              run,
              closureBatchSize,
              closureLimits,
              options.requestedBy ?? "thread-worker",
              attempted
            );
          } else if (run.stage === "subject") {
            processed = await this.processSubjectWork(
              client,
              run,
              batchSize,
              closureLimits,
              maxSubjectBucketMessages,
              options.requestedBy ?? "thread-worker",
              attempted
            );
          } else {
            processed = await this.processCatchup(
              client,
              run,
              closureBatchSize,
              closureLimits,
              maxSubjectBucketMessages,
              options.requestedBy ?? "thread-worker",
              attempted
            );
          }

          await client.query(
            `UPDATE public.imap_thread_runs
             SET attempts = 0, available_at = now(), last_error = NULL
             WHERE id = $1`,
            [run.id]
          );
          if ((run.status !== "building" || processed.runStatus === "ready") && !(await this.runHasAnyWork(client, run.id))) {
            await this.markRunCaughtUp(client, run);
          }
          await client.query("COMMIT");
          return processed;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          if (failedRun) {
            await this.recordFailureWithClient(
              client,
              failedRun,
              attemptedIds,
              error,
              options.requestedBy ?? "thread-worker",
              attemptedCanSubdivide
            );
          }
          throw error;
        }
      });

    const drained = result ?? { ...this.emptyResult(accountId), busy: true };
    if (
      !options.activateInitial ||
      !drained.ready ||
      drained.active ||
      drained.runStatus !== "ready" ||
      !drained.runId
    ) {
      return drained;
    }

    const readyRun = await this.getRun(drained.runId);
    if (readyRun.mode !== "initial") return drained;
    const activated = await this.activateRun(accountId, drained.runId, {
      requestedBy: options.requestedBy ?? "thread-worker",
      reason: "automatic initial conversation activation"
    });
    return {
      ...activated,
      messagesConsidered: drained.messagesConsidered,
      assignmentsChanged: drained.assignmentsChanged,
      queueItemsProcessed: drained.queueItemsProcessed
    };
  }

  async processAccount(accountId: string, options: DrainThreadingOptions = {}): Promise<ThreadingRunResult> {
    return this.drainAccount(accountId, options);
  }

  async rebuildAccount(accountId: string, options: RebuildThreadingOptions = {}): Promise<ThreadingRunResult> {
    const runId = await this.startRebuild(accountId, options);
    let aggregate = this.emptyResult(accountId);
    for (let pass = 0; pass < 1_000_000; pass += 1) {
      const result = await this.drainAccount(accountId, options);
      aggregate = {
        ...result,
        messagesConsidered: aggregate.messagesConsidered + result.messagesConsidered,
        assignmentsChanged: aggregate.assignmentsChanged + result.assignmentsChanged,
        queueItemsProcessed: aggregate.queueItemsProcessed + result.queueItemsProcessed
      };
      const status = await this.getRun(runId);
      if (status.status === "ready") {
        if (options.activate) {
          const activated = await this.activateRun(accountId, runId, {
            requestedBy: options.requestedBy,
            reason: options.reason ?? "explicit rebuild activation"
          });
          return {
            ...activated,
            messagesConsidered: aggregate.messagesConsidered,
            assignmentsChanged: aggregate.assignmentsChanged,
            queueItemsProcessed: aggregate.queueItemsProcessed
          };
        }
        return { ...aggregate, runId, runStatus: "ready", stage: "ready", ready: true };
      }
      if (status.status === "failed") throw new Error(status.lastError ?? `Threading run ${runId} failed`);
      if (result.busy) throw new Error(`Threading account ${accountId} is unavailable or already being processed; resume the rebuild later`);
    }
    throw new Error(`Threading rebuild ${runId} exceeded the maximum number of bounded passes`);
  }

  async startRebuild(accountId: string, options: RebuildThreadingOptions = {}): Promise<string> {
    const result = await this.withAccountLock(accountId, async (client) => {
      await client.query("BEGIN");
      try {
        const state = await this.lockState(client, accountId);
        if (state.building_run_id) {
          const existing = await this.loadRun(client, state.building_run_id);
          this.requireExecutor(existing, "candidate");
          if (existing && existing.algorithm_version > this.currentAlgorithmVersion) {
            throw this.versionSkew(existing.algorithm_version);
          }
          if (existing && existing.status === "building") {
            if (existing.algorithm_version === this.currentAlgorithmVersion) {
              await client.query("COMMIT");
              return existing.id;
            }
            await client.query(
              `UPDATE public.imap_thread_runs
               SET status = 'failed', last_error = 'superseded by explicit rebuild', completed_at = now()
               WHERE id = $1`,
              [existing.id]
            );
            await this.clearRunWork(client, existing.id);
          }
          if (existing && existing.status === "ready") {
            await client.query(
              "UPDATE public.imap_thread_runs SET status = 'archived', superseded_at = now() WHERE id = $1",
              [existing.id]
            );
            await this.clearRunWork(client, existing.id);
          }
        }
        const active = state.active_run_id ? await this.loadRun(client, state.active_run_id) : null;
        this.requireExecutor(active, "active");
        const standby = state.previous_run_id ? await this.loadRun(client, state.previous_run_id) : null;
        this.requireExecutor(standby, "standby");
        if (active && active.algorithm_version > this.currentAlgorithmVersion) {
          throw this.versionSkew(active.algorithm_version);
        }
        const run = await this.createBuildRun(
          client,
          state,
          active,
          "rebuild",
          options.requestedBy ?? "operator",
          options.reason ?? "deterministic shadow rebuild"
        );
        await client.query("COMMIT");
        return run.id;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    if (!result) throw new Error(`Threading is already running for account ${accountId}`);
    return result;
  }

  async activateRun(
    accountId: string,
    runId: string,
    options: ActivateThreadingOptions = {}
  ): Promise<ThreadingRunResult> {
    const result = await this.withAccountLock(accountId, async (client) => {
      // The state-row lock is the serialization point. READ COMMITTED matters:
      // after waiting for a mirror writer's SHARE lock, coverage checks must see
      // that writer's just-committed queue entry rather than an older snapshot.
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SELECT set_config('statement_timeout', '30s', true)");
      try {
        const state = await this.lockState(client, accountId);
        const run = await this.loadRun(client, runId);
        if (!run || run.account_id !== accountId) throw new Error(`Threading run not found: ${runId}`);
        if (run.algorithm_version !== this.currentAlgorithmVersion) throw this.versionSkew(run.algorithm_version);
        if (run.status !== "ready" || run.stage !== "ready") {
          throw new Error(`Threading run ${runId} is not ready for activation`);
        }
        const active = state.active_run_id ? await this.loadRun(client, state.active_run_id) : null;
        this.requireExecutor(active, "active");
        if (await this.runHasAnyWork(client, runId)) {
          throw new Error(`Threading run ${runId} changed after review and must catch up before activation`);
        }
        const clock = await client.query<{ revision: string }>(
          `SELECT coalesce((
             SELECT revision FROM public.imap_thread_evidence_clock WHERE account_id = $1
           ), 0)::text AS revision`,
          [accountId]
        );
        const evidenceRevision = clock.rows[0]?.revision ?? "0";
        if (run.caught_up_revision !== evidenceRevision) {
          throw new Error(
            `Threading run ${runId} is stale at evidence revision ${run.caught_up_revision}; current revision is ${evidenceRevision}`
          );
        }
        if (state.active_run_id) {
          if (!options.comparisonId) {
            throw new Error("Replacing an active threading run requires a passed comparison certificate");
          }
          const reviewed = await client.query<{
            baseline_run_id: string;
            candidate_run_id: string;
            baseline_generation: string;
            candidate_generation: string;
            evidence_revision: string;
            passed: boolean;
          }>(
            `SELECT baseline_run_id, candidate_run_id,
                    baseline_generation::text, candidate_generation::text,
                    evidence_revision::text, passed
             FROM public.imap_thread_run_comparisons
             WHERE id = $1 AND account_id = $2
             FOR SHARE`,
            [options.comparisonId, accountId]
          );
          const certificate = reviewed.rows[0];
          if (!certificate || !certificate.passed) {
            throw new Error("Threading comparison certificate is missing or did not pass its thresholds");
          }
          if (
            certificate.baseline_run_id !== state.active_run_id ||
            certificate.candidate_run_id !== runId ||
            certificate.evidence_revision !== evidenceRevision
          ) {
            throw new Error("Threading comparison certificate does not match the current rollout state");
          }
          const baselineGeneration = await this.currentGeneration(client, state.active_run_id);
          const candidateGeneration = await this.currentGeneration(client, runId);
          if (
            certificate.baseline_generation !== baselineGeneration ||
            certificate.candidate_generation !== candidateGeneration
          ) {
            throw new Error("Threading projections changed after review; run a new comparison before activation");
          }
        }

        const coverage = await client.query<{ missing: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM public.imap_messages message
             WHERE message.account_id = $1
               AND NOT EXISTS (
                 SELECT 1 FROM public.imap_thread_assignments assignment
                 WHERE assignment.run_id = $2
                   AND assignment.message_id = message.id
               )
             LIMIT 1
           ) AS missing`,
          [accountId, runId]
        );
        if (coverage.rows[0]?.missing !== false) {
          throw new Error(`Threading run ${runId} is incomplete; at least one message has no assignment`);
        }

        if (state.previous_run_id && state.previous_run_id !== state.active_run_id) {
          await client.query(
            "UPDATE public.imap_thread_runs SET status = 'archived', superseded_at = now() WHERE id = $1",
            [state.previous_run_id]
          );
          await client.query("DELETE FROM public.imap_thread_work_queue WHERE run_id = $1", [state.previous_run_id]);
          await client.query("DELETE FROM public.imap_thread_subject_work WHERE run_id = $1", [state.previous_run_id]);
        }
        if (state.active_run_id) {
          await client.query(
            "UPDATE public.imap_thread_runs SET status = 'standby', superseded_at = now() WHERE id = $1",
            [state.active_run_id]
          );
        }
        await client.query(
          `UPDATE public.imap_thread_runs
           SET status = 'active', activated_at = now(), completed_at = coalesce(completed_at, now())
           WHERE id = $1`,
          [runId]
        );
        await client.query(
          `UPDATE public.imap_thread_state
           SET active_run_id = $2,
               previous_run_id = active_run_id,
               building_run_id = NULL,
               paused_at = NULL,
               pause_reason = NULL
           WHERE account_id = $1`,
          [accountId, runId]
        );
        const operation = await this.insertOperation(client, {
          run,
          type: "activate",
          requestedBy: options.requestedBy ?? "operator",
          reason: options.reason ?? "quality-gated atomic activation",
          parameters: { from_run_id: state.active_run_id, to_run_id: runId },
          summary: {
            coverage_complete: true,
            evidence_revision: evidenceRevision,
            generation: await this.currentGeneration(client, runId)
          }
        });
        // Activation rollback swaps run pointers. Per-message history from the
        // former active run can no longer be used and must not grow as an
        // unbounded audit log.
        await this.clearAssignmentHistory(client, accountId);
        await client.query("COMMIT");
        return this.resultForRun(accountId, { ...run, status: "active" }, {
          operationId: operation,
          operationType: "activate",
          active: true,
          ready: true
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    if (!result) throw new Error(`Threading is already running for account ${accountId}`);
    return result;
  }

  async rollbackOperation(accountId: string, operationId: string, requestedBy = "operator"): Promise<ThreadingRunResult> {
    const result = await this.withAccountLock(accountId, async (client) => {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        const state = await this.lockState(client, accountId);
        const targetResult = await client.query<{
          id: string;
          run_id: string;
          operation_type: OperationType;
          status: string;
          parameters: Record<string, unknown>;
          assignments_changed: number;
        }>(
          `
          SELECT id, run_id, operation_type, status, parameters,
                 coalesce((summary->>'assignments_changed')::integer, 0) AS assignments_changed
          FROM public.imap_thread_operations
          WHERE id = $1 AND account_id = $2
          FOR UPDATE
          `,
          [operationId, accountId]
        );
        const target = targetResult.rows[0];
        if (!target || target.status !== "succeeded") throw new Error(`Rollback target is not a successful operation: ${operationId}`);
        const run = await this.loadRun(client, target.run_id);
        if (!run) throw new Error(`Threading run missing for operation ${operationId}`);

        if (target.operation_type === "activate") {
          if (state.active_run_id !== target.run_id) {
            throw new Error("Only the currently active activation can be rolled back");
          }
          const previousRunId = target.parameters.from_run_id == null
            ? null
            : String(target.parameters.from_run_id);
          if (previousRunId && await this.runHasAnyWork(client, previousRunId)) {
            throw new Error("Standby run has unprocessed changes; refusing a stale rollout rollback");
          }
          if (previousRunId) {
            const previous = await this.loadRun(client, previousRunId);
            if (!previous || previous.account_id !== accountId) throw new Error("Previous threading run is unavailable");
            this.requireExecutor(previous, "standby");
            const clock = await client.query<{ revision: string }>(
              `SELECT coalesce((
                 SELECT revision FROM public.imap_thread_evidence_clock WHERE account_id = $1
               ), 0)::text AS revision`,
              [accountId]
            );
            if (previous.caught_up_revision !== (clock.rows[0]?.revision ?? "0")) {
              throw new Error("Standby run has not acknowledged the latest evidence revision; refusing rollback");
            }
            await client.query("UPDATE public.imap_thread_runs SET status = 'active' WHERE id = $1", [previousRunId]);
          }
          await client.query("UPDATE public.imap_thread_runs SET status = 'rolled_back' WHERE id = $1", [run.id]);
          await client.query(
            `UPDATE public.imap_thread_state
             SET active_run_id = $2,
                 previous_run_id = $3,
                 building_run_id = NULL,
                 paused_at = now(),
                 pause_reason = $4
             WHERE account_id = $1`,
            [accountId, previousRunId, run.id, `rolled back activation ${operationId}; rebuild before resuming`]
          );
          const rollbackId = await this.insertOperation(client, {
            run,
            type: "rollback",
            requestedBy,
            reason: "atomic active-run rollback",
            reversesOperationId: operationId,
            parameters: { from_run_id: run.id, to_run_id: previousRunId },
            summary: { pointer_swap: true }
          });
          await client.query(
            "UPDATE public.imap_thread_operations SET status = 'rolled_back', rolled_back_at = now() WHERE id = $1",
            [operationId]
          );
          await this.clearAssignmentHistory(client, accountId);
          await client.query("COMMIT");
          return this.resultForRun(accountId, { ...run, status: "rolled_back" }, {
            operationId: rollbackId,
            operationType: "rollback",
            active: false,
            ready: false
          });
        }

        if (state.active_run_id !== run.id || target.operation_type !== "incremental") {
          throw new Error("Only the latest active incremental operation or active rollout can be rolled back");
        }
        const latest = await client.query<{ id: string }>(
          `SELECT id FROM public.imap_thread_operations
           WHERE run_id = $1 AND to_generation IS NOT NULL AND status = 'succeeded'
           ORDER BY to_generation DESC LIMIT 1 FOR UPDATE`,
          [run.id]
        );
        if (latest.rows[0]?.id !== operationId) {
          throw new Error("Only the latest material threading operation can be rolled back");
        }
        const history = await client.query<{
          message_id: string;
          previous_assignment: Record<string, unknown> | null;
        }>(
          `SELECT message_id, previous_assignment
           FROM public.imap_thread_assignment_history
           WHERE operation_id = $1 AND account_id = $2 ORDER BY message_id`,
          [operationId, accountId]
        );
        if (history.rows.length === 0 || history.rows.length !== target.assignments_changed) {
          throw new Error("Threading operation has incomplete history; refusing a partial rollback");
        }
        const current = await this.loadStoredAssignments(client, run.id, history.rows.map((row) => row.message_id));
        const currentById = new Map(current.map((row) => [row.message_id, row]));
        const generation = (BigInt(await this.currentGeneration(client, run.id)) + 1n).toString();
        const restores: AssignmentRecord[] = [];
        const deletes: string[] = [];
        for (const entry of history.rows) {
          const existing = currentById.get(entry.message_id);
          if (!existing) throw new Error(`Current assignment missing for ${entry.message_id}; refusing a partial rollback`);
          if (entry.previous_assignment) {
            const restored = restoreSnapshot(entry.previous_assignment, generation);
            restores.push(restored);
          } else {
            deletes.push(entry.message_id);
          }
        }
        const rollbackId = await this.insertOperation(client, {
          run,
          type: "rollback",
          requestedBy,
          reason: "incremental assignment rollback",
          reversesOperationId: operationId,
          fromGeneration: await this.currentGeneration(client, run.id),
          toGeneration: generation,
          summary: { assignments_changed: history.rows.length }
        });
        await this.upsertAssignments(client, restores);
        if (deletes.length > 0) {
          await client.query(
            "DELETE FROM public.imap_thread_assignments WHERE run_id = $1 AND message_id = ANY($2::uuid[])",
            [run.id, deletes]
          );
        }
        await client.query(
          "UPDATE public.imap_thread_operations SET status = 'rolled_back', rolled_back_at = now() WHERE id = $1",
          [operationId]
        );
        // A rollback operation is not itself rollbackable. Its compact
        // operation row remains for audit; the large snapshots do not.
        await this.clearAssignmentHistory(client, accountId);
        await client.query(
          `UPDATE public.imap_thread_state
           SET paused_at = now(), pause_reason = $2 WHERE account_id = $1`,
          [accountId, `rolled back incremental operation ${operationId}; rebuild before resuming`]
        );
        await client.query("COMMIT");
        return this.resultForRun(accountId, run, {
          operationId: rollbackId,
          operationType: "rollback",
          generation,
          assignmentsChanged: history.rows.length,
          messagesConsidered: history.rows.length,
          active: true,
          ready: true
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    if (!result) throw new Error(`Threading is already running for account ${accountId}`);
    return result;
  }

  async getRun(runId: string): Promise<{
    id: string;
    mode: RunMode;
    status: RunStatus;
    stage: RunStage;
    lastError: string | null;
  }> {
    const result = await this.pool.query<{
      id: string;
      mode: RunMode;
      status: RunStatus;
      stage: RunStage;
      last_error: string | null;
    }>("SELECT id, mode, status, stage, last_error FROM public.imap_thread_runs WHERE id = $1", [runId]);
    const row = result.rows[0];
    if (!row) throw new Error(`Threading run not found: ${runId}`);
    return { id: row.id, mode: row.mode, status: row.status, stage: row.stage, lastError: row.last_error };
  }

  /**
   * Remove old projection state in bounded batches while retaining immutable
   * operations and comparison certificates for audit.
   */
  async pruneTerminalRuns(options: {
    olderThanDays?: number;
    batchSize?: number;
  } = {}): Promise<{ runsDeleted: number; assignmentsDeleted: number }> {
    const olderThanDays = Math.max(1, Math.min(
      Number.isFinite(options.olderThanDays) ? Math.floor(Number(options.olderThanDays)) : 30,
      3_650
    ));
    const batchSize = Math.max(1, Math.min(
      Number.isFinite(options.batchSize) ? Math.floor(Number(options.batchSize)) : 100,
      1_000
    ));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const candidates = await client.query<{ id: string }>(
        `SELECT run.id
         FROM public.imap_thread_runs run
         WHERE run.status IN ('archived', 'failed', 'rolled_back')
           AND coalesce(run.superseded_at, run.completed_at, run.updated_at)
                 < now() - ($1::integer * interval '1 day')
           AND NOT EXISTS (
             SELECT 1 FROM public.imap_thread_state state
             WHERE state.active_run_id = run.id
                OR state.previous_run_id = run.id
                OR state.building_run_id = run.id
           )
         ORDER BY coalesce(run.superseded_at, run.completed_at, run.updated_at), run.id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [olderThanDays, batchSize]
      );
      const runIds = candidates.rows.map((row) => row.id);
      if (runIds.length === 0) {
        await client.query("COMMIT");
        return { runsDeleted: 0, assignmentsDeleted: 0 };
      }
      const assignmentCount = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM public.imap_thread_assignments WHERE run_id = ANY($1::uuid[])`,
        [runIds]
      );
      const deleted = await client.query(
        "DELETE FROM public.imap_thread_runs WHERE id = ANY($1::uuid[])",
        [runIds]
      );
      await client.query("COMMIT");
      return {
        runsDeleted: deleted.rowCount ?? 0,
        assignmentsDeleted: Number(assignmentCount.rows[0]?.count ?? 0)
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Durable disagreement certificate for quality-gating a shadow run before activation. */
  async compareRuns(
    accountId: string,
    baselineRunId: string,
    candidateRunId: string,
    sampleSize = 100,
    options: CompareThreadingOptions = {}
  ): Promise<ThreadingRunComparison> {
    const boundedSampleSize = Math.max(0, Math.min(
      Number.isFinite(sampleSize) ? Math.floor(sampleSize) : 100,
      1_000
    ));
    const thresholds = comparisonThresholds(options.thresholds);
    const statementTimeoutMs = Math.max(1_000, Math.min(
      Number.isFinite(options.statementTimeoutMs)
        ? Math.floor(Number(options.statementTimeoutMs))
        : DEFAULT_COMPARISON_STATEMENT_TIMEOUT_MS,
      300_000
    ));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${statementTimeoutMs}ms`]);
      await client.query("SELECT set_config('lock_timeout', '5s', true)");
      const runs = await client.query<{
        id: string;
        algorithm_version: number;
        status: RunStatus;
        stage: RunStage;
        caught_up_revision: string;
      }>(
        `SELECT id, algorithm_version, status, stage, caught_up_revision::text
         FROM public.imap_thread_runs
         WHERE account_id = $1 AND id = ANY($2::uuid[])
         ORDER BY id`,
        [accountId, [baselineRunId, candidateRunId]]
      );
      const byId = new Map(runs.rows.map((run) => [run.id, run]));
      const baselineRun = byId.get(baselineRunId);
      const candidateRun = byId.get(candidateRunId);
      if (!baselineRun) throw new Error(`Baseline threading run not found for account: ${baselineRunId}`);
      if (!candidateRun) throw new Error(`Candidate threading run not found for account: ${candidateRunId}`);
      if (baselineRun.status !== "active" || baselineRun.stage !== "ready") {
        throw new Error(`Baseline threading run is not the active ready projection: ${baselineRunId}`);
      }
      if (candidateRun.status !== "ready" || candidateRun.stage !== "ready") {
        throw new Error(`Candidate threading run is not ready for comparison: ${candidateRunId}`);
      }
      if (await this.runHasAnyWork(client, baselineRunId) || await this.runHasAnyWork(client, candidateRunId)) {
        throw new Error("Threading runs changed before comparison and must catch up first");
      }
      const evidenceClock = await client.query<{ revision: string }>(
        `SELECT coalesce((
           SELECT revision FROM public.imap_thread_evidence_clock WHERE account_id = $1
         ), 0)::text AS revision`,
        [accountId]
      );
      const evidenceRevision = evidenceClock.rows[0]?.revision ?? "0";
      if (
        baselineRun.caught_up_revision !== evidenceRevision ||
        candidateRun.caught_up_revision !== evidenceRevision
      ) {
        throw new Error(
          `Threading comparison requires caught-up runs at evidence revision ${evidenceRevision}`
        );
      }
      const baselineGeneration = await this.currentGeneration(client, baselineRunId);
      const candidateGeneration = await this.currentGeneration(client, candidateRunId);

      const summary = await client.query<{
        baseline_assignments: string;
        candidate_assignments: string;
        unchanged_assignments: string;
        changed_assignments: string;
        only_baseline_assignments: string;
        only_candidate_assignments: string;
        baseline_deliveries: string;
        candidate_deliveries: string;
        baseline_conversations: string;
        candidate_conversations: string;
        split_groups: string;
        split_messages: string;
        merge_groups: string;
        merge_messages: string;
        provisional_before: string;
        provisional_after: string;
        provisional_resolved: string;
        provisional_introduced: string;
        baseline_methods: Record<string, number>;
        candidate_methods: Record<string, number>;
      }>(
        `WITH
         baseline AS (
           SELECT message_id, delivery_key, conversation_id, assignment_method,
                  confidence, is_provisional, root_reference_hash,
                  parent_reference_hash, parent_delivery_key
           FROM public.imap_thread_assignments WHERE run_id = $1
         ),
         candidate AS (
           SELECT message_id, delivery_key, conversation_id, assignment_method,
                  confidence, is_provisional, root_reference_hash,
                  parent_reference_hash, parent_delivery_key
           FROM public.imap_thread_assignments WHERE run_id = $2
         ),
         paired AS (
           SELECT coalesce(baseline.message_id, candidate.message_id) AS message_id,
                  baseline.message_id AS baseline_message_id,
                  candidate.message_id AS candidate_message_id,
                  baseline.delivery_key AS baseline_delivery_key,
                  candidate.delivery_key AS candidate_delivery_key,
                  baseline.conversation_id AS baseline_conversation_id,
                  candidate.conversation_id AS candidate_conversation_id,
                  baseline.assignment_method AS baseline_method,
                  candidate.assignment_method AS candidate_method,
                  baseline.confidence AS baseline_confidence,
                  candidate.confidence AS candidate_confidence,
                  baseline.is_provisional AS baseline_provisional,
                  candidate.is_provisional AS candidate_provisional,
                  baseline.root_reference_hash AS baseline_root,
                  candidate.root_reference_hash AS candidate_root,
                  baseline.parent_reference_hash AS baseline_parent,
                  candidate.parent_reference_hash AS candidate_parent,
                  baseline.parent_delivery_key AS baseline_parent_delivery,
                  candidate.parent_delivery_key AS candidate_parent_delivery
           FROM baseline FULL JOIN candidate USING (message_id)
         ),
         overlap AS (
           SELECT * FROM paired
           WHERE baseline_message_id IS NOT NULL AND candidate_message_id IS NOT NULL
         ),
         changed AS (
           SELECT * FROM overlap WHERE
             baseline_delivery_key IS DISTINCT FROM candidate_delivery_key
             OR baseline_conversation_id IS DISTINCT FROM candidate_conversation_id
             OR baseline_method IS DISTINCT FROM candidate_method
             OR baseline_confidence IS DISTINCT FROM candidate_confidence
             OR baseline_provisional IS DISTINCT FROM candidate_provisional
             OR baseline_root IS DISTINCT FROM candidate_root
             OR baseline_parent IS DISTINCT FROM candidate_parent
             OR baseline_parent_delivery IS DISTINCT FROM candidate_parent_delivery
         ),
         split_group AS (
           SELECT baseline_conversation_id, count(DISTINCT message_id)::integer AS messages
           FROM overlap
           GROUP BY baseline_conversation_id
           HAVING count(DISTINCT candidate_conversation_id) > 1
         ),
         merge_group AS (
           SELECT candidate_conversation_id, count(DISTINCT message_id)::integer AS messages
           FROM overlap
           GROUP BY candidate_conversation_id
           HAVING count(DISTINCT baseline_conversation_id) > 1
         ),
         baseline_method_count AS (
           SELECT assignment_method, count(*)::integer AS count
           FROM (SELECT DISTINCT delivery_key, assignment_method FROM baseline) delivery
           GROUP BY assignment_method
         ),
         candidate_method_count AS (
           SELECT assignment_method, count(*)::integer AS count
           FROM (SELECT DISTINCT delivery_key, assignment_method FROM candidate) delivery
           GROUP BY assignment_method
         )
         SELECT
           (SELECT count(*) FROM baseline)::text AS baseline_assignments,
           (SELECT count(*) FROM candidate)::text AS candidate_assignments,
           ((SELECT count(*) FROM overlap) - (SELECT count(*) FROM changed))::text AS unchanged_assignments,
           (SELECT count(*) FROM changed)::text AS changed_assignments,
           (SELECT count(*) FROM paired WHERE candidate_message_id IS NULL)::text AS only_baseline_assignments,
           (SELECT count(*) FROM paired WHERE baseline_message_id IS NULL)::text AS only_candidate_assignments,
           (SELECT count(DISTINCT delivery_key) FROM baseline)::text AS baseline_deliveries,
           (SELECT count(DISTINCT delivery_key) FROM candidate)::text AS candidate_deliveries,
           (SELECT count(DISTINCT conversation_id) FROM baseline)::text AS baseline_conversations,
           (SELECT count(DISTINCT conversation_id) FROM candidate)::text AS candidate_conversations,
           (SELECT count(*) FROM split_group)::text AS split_groups,
           coalesce((SELECT sum(messages) FROM split_group), 0)::text AS split_messages,
           (SELECT count(*) FROM merge_group)::text AS merge_groups,
           coalesce((SELECT sum(messages) FROM merge_group), 0)::text AS merge_messages,
           (SELECT count(*) FROM baseline WHERE is_provisional)::text AS provisional_before,
           (SELECT count(*) FROM candidate WHERE is_provisional)::text AS provisional_after,
           (SELECT count(*) FROM overlap WHERE baseline_provisional AND NOT candidate_provisional)::text
             AS provisional_resolved,
           (SELECT count(*) FROM overlap WHERE NOT baseline_provisional AND candidate_provisional)::text
             AS provisional_introduced,
           coalesce((SELECT jsonb_object_agg(assignment_method, count) FROM baseline_method_count), '{}'::jsonb)
             AS baseline_methods,
           coalesce((SELECT jsonb_object_agg(assignment_method, count) FROM candidate_method_count), '{}'::jsonb)
             AS candidate_methods`,
        [baselineRunId, candidateRunId]
      );
      const row = summary.rows[0];
      const samples = await client.query<{
        message_id: string;
        baseline_conversation_id: string | null;
        candidate_conversation_id: string | null;
        baseline_delivery_key: string | null;
        candidate_delivery_key: string | null;
        baseline_method: ThreadingAssignment["method"] | null;
        candidate_method: ThreadingAssignment["method"] | null;
        baseline_provisional: boolean | null;
        candidate_provisional: boolean | null;
      }>(
        `WITH baseline AS (
           SELECT message_id, delivery_key, conversation_id, assignment_method, confidence,
                  is_provisional, root_reference_hash, parent_reference_hash, parent_delivery_key
           FROM public.imap_thread_assignments WHERE run_id = $1
         ), candidate AS (
           SELECT message_id, delivery_key, conversation_id, assignment_method, confidence,
                  is_provisional, root_reference_hash, parent_reference_hash, parent_delivery_key
           FROM public.imap_thread_assignments WHERE run_id = $2
         )
         SELECT coalesce(baseline.message_id, candidate.message_id) AS message_id,
                baseline.conversation_id AS baseline_conversation_id,
                candidate.conversation_id AS candidate_conversation_id,
                baseline.delivery_key AS baseline_delivery_key,
                candidate.delivery_key AS candidate_delivery_key,
                baseline.assignment_method AS baseline_method,
                candidate.assignment_method AS candidate_method,
                baseline.is_provisional AS baseline_provisional,
                candidate.is_provisional AS candidate_provisional
         FROM baseline FULL JOIN candidate USING (message_id)
         WHERE baseline.message_id IS NULL OR candidate.message_id IS NULL
            OR baseline.delivery_key IS DISTINCT FROM candidate.delivery_key
            OR baseline.conversation_id IS DISTINCT FROM candidate.conversation_id
            OR baseline.assignment_method IS DISTINCT FROM candidate.assignment_method
            OR baseline.confidence IS DISTINCT FROM candidate.confidence
            OR baseline.is_provisional IS DISTINCT FROM candidate.is_provisional
            OR baseline.root_reference_hash IS DISTINCT FROM candidate.root_reference_hash
            OR baseline.parent_reference_hash IS DISTINCT FROM candidate.parent_reference_hash
            OR baseline.parent_delivery_key IS DISTINCT FROM candidate.parent_delivery_key
         ORDER BY coalesce(baseline.message_id, candidate.message_id)
         LIMIT $3`,
        [baselineRunId, candidateRunId, boundedSampleSize]
      );
      const number = (value: string): number => Number(value);
      const metrics = {
        baselineAssignments: number(row.baseline_assignments),
        candidateAssignments: number(row.candidate_assignments),
        unchangedAssignments: number(row.unchanged_assignments),
        changedAssignments: number(row.changed_assignments),
        onlyBaselineAssignments: number(row.only_baseline_assignments),
        onlyCandidateAssignments: number(row.only_candidate_assignments),
        baselineDeliveries: number(row.baseline_deliveries),
        candidateDeliveries: number(row.candidate_deliveries),
        baselineConversations: number(row.baseline_conversations),
        candidateConversations: number(row.candidate_conversations),
        conversationSplits: { groups: number(row.split_groups), messages: number(row.split_messages) },
        conversationMerges: { groups: number(row.merge_groups), messages: number(row.merge_messages) },
        provisionalBefore: number(row.provisional_before),
        provisionalAfter: number(row.provisional_after),
        provisionalResolved: number(row.provisional_resolved),
        provisionalIntroduced: number(row.provisional_introduced),
        baselineMethods: row.baseline_methods,
        candidateMethods: row.candidate_methods
      };
      const passed =
        metrics.conversationMerges.groups <= thresholds.maxConversationMergeGroups &&
        metrics.conversationSplits.groups <= thresholds.maxConversationSplitGroups &&
        metrics.provisionalIntroduced <= thresholds.maxProvisionalIntroduced &&
        metrics.onlyBaselineAssignments <= thresholds.maxOnlyBaselineAssignments &&
        metrics.onlyCandidateAssignments <= thresholds.maxOnlyCandidateAssignments;
      const certificate = await client.query<{ id: string }>(
        `INSERT INTO public.imap_thread_run_comparisons (
           account_id, baseline_run_id, candidate_run_id,
           baseline_algorithm_version, candidate_algorithm_version,
           baseline_generation, candidate_generation, evidence_revision,
           passed, thresholds, summary, requested_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10::jsonb, $11::jsonb, $12
         ) RETURNING id`,
        [
          accountId,
          baselineRunId,
          candidateRunId,
          baselineRun.algorithm_version,
          candidateRun.algorithm_version,
          baselineGeneration,
          candidateGeneration,
          evidenceRevision,
          passed,
          JSON.stringify(thresholds),
          JSON.stringify(metrics),
          options.requestedBy ?? "operator"
        ]
      );
      const comparisonId = certificate.rows[0]?.id;
      if (!comparisonId) throw new Error("Failed to persist threading comparison certificate");
      const report: ThreadingRunComparison = {
        comparisonId,
        accountId,
        baselineRunId,
        candidateRunId,
        baselineAlgorithmVersion: baselineRun.algorithm_version,
        candidateAlgorithmVersion: candidateRun.algorithm_version,
        baselineGeneration,
        candidateGeneration,
        evidenceRevision,
        passed,
        thresholds,
        ...metrics,
        samples: samples.rows.map((sample) => ({
          messageId: sample.message_id,
          baselineConversationId: sample.baseline_conversation_id,
          candidateConversationId: sample.candidate_conversation_id,
          baselineDeliveryKey: sample.baseline_delivery_key,
          candidateDeliveryKey: sample.candidate_delivery_key,
          baselineMethod: sample.baseline_method,
          candidateMethod: sample.candidate_method,
          baselineProvisional: sample.baseline_provisional,
          candidateProvisional: sample.candidate_provisional
        }))
      };
      await client.query("COMMIT");
      return report;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async processBodyEvidencePage(
    client: PgClient,
    run: ThreadRun,
    batchSize: number,
    bodyHashesBackfilled: number,
    requestedBy: string
  ): Promise<ThreadingRunResult> {
    const page = await this.loadPhysicalPage(client, run, batchSize);
    if (page.length === 0) {
      const next = await this.setRunStage(client, run, "strong", null);
      return this.resultForRun(run.account_id, next);
    }
    const last = page.at(-1) as PhysicalPageRow;
    const nextStage = page.length < batchSize ? "strong" : "body_evidence";
    const updated = await this.setRunStage(client, run, nextStage, nextStage === "strong" ? null : cursorFrom(last));
    const operation = await this.insertOperation(client, {
      run,
      type: "build_batch",
      requestedBy,
      reason: "bounded existing-body evidence pass",
      summary: { messages_considered: page.length, mime_hashes_backfilled: bodyHashesBackfilled }
    });
    return this.resultForRun(run.account_id, updated, {
      operationId: operation,
      operationType: "build_batch",
      messagesConsidered: page.length
    });
  }

  /**
   * Repair complete MIME fingerprints written by binaries that predate the
   * digest column. This must remain outside the thread-state FOR UPDATE
   * transaction: legacy body writers acquire these row locks in the opposite
   * order before the database-owned evidence trigger runs.
   */
  private async backfillBodyEvidenceBatchWithinDeadline(
    client: PgClient,
    accountId: string,
    limit: number
  ): Promise<number> {
    await client.query("BEGIN");
    try {
      await client.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [`${this.bodyEvidenceStatementTimeoutMs}ms`]
      );
      const changed = await this.backfillBodyEvidenceBatch(client, accountId, limit);
      await client.query("COMMIT");
      return changed;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  private async backfillBodyEvidenceBatch(client: PgClient, accountId: string, limit: number): Promise<number> {
    const bridged = await this.backfillQueuedDeliveryBridgeBatch(client, accountId, limit);
    if (bridged >= limit) return bridged;
    return bridged + await this.backfillLegacyBodyEvidenceBatch(client, accountId, limit - bridged);
  }

  private async backfillQueuedDeliveryBridgeBatch(
    client: PgClient,
    accountId: string,
    limit: number
  ): Promise<number> {
    if (limit <= 0) return 0;
    const queued = await client.query<{ message_id: string }>(
      `SELECT queue.message_id
       FROM public.imap_thread_work_queue queue
       WHERE queue.account_id = $1
         AND queue.reason = $2
       GROUP BY queue.message_id
       ORDER BY min(queue.enqueued_at), queue.message_id
       LIMIT $3`,
      [accountId, DELIVERY_EVIDENCE_BRIDGE_REASON, limit]
    );
    const queuedIds = queued.rows.map((row) => row.message_id);
    if (queuedIds.length === 0) return 0;

    const candidates = await client.query<{
      message_id: string;
      authored_delivery_sha256: string;
    }>(
      `SELECT body.message_id,
              encode(extensions.digest(convert_to(jsonb_build_object(
                'message_id', body.headers_json -> 'message-id',
                'date', body.headers_json -> 'date',
                'subject', message.subject,
                'from_email', message.from_email,
                'to_emails', message.to_emails,
                'cc_emails', message.cc_emails,
                'bcc_emails', message.bcc_emails,
                'threading_payload_sha256', body.threading_payload_sha256,
                'content_type', body.headers_json -> 'content-type',
                'content_transfer_encoding', body.headers_json -> 'content-transfer-encoding',
                'mime_version', body.headers_json -> 'mime-version',
                'mime_structure', body.mime_structure,
                'parser_warnings', body.parser_warnings,
                'structured_evidence_sha256', body.structured_evidence_sha256
              )::text, 'UTF8'), 'sha256'), 'hex') AS authored_delivery_sha256
       FROM public.imap_message_bodies body
       JOIN public.imap_messages message ON message.id = body.message_id
       WHERE body.message_id = ANY($1::uuid[])
         AND body.authored_delivery_sha256 IS NULL
         AND NOT body.raw_truncated
         AND body.raw_bytes > 0
         AND message.from_email IS NOT NULL
         AND body.headers_json ? 'message-id'
         AND body.headers_json ? 'from'
         AND body.headers_json ? 'date'
         AND cardinality(
           coalesce(message.to_emails, '{}'::text[]) ||
           coalesce(message.cc_emails, '{}'::text[]) ||
           coalesce(message.bcc_emails, '{}'::text[])
         ) > 0
         AND body.threading_payload_sha256 IS NOT NULL
         AND body.mime_structure IS NOT NULL
         AND body.structured_evidence_complete
         AND body.structured_evidence_sha256 IS NOT NULL
       ORDER BY body.message_id
       FOR UPDATE OF body`,
      [queuedIds]
    );

    const eligibleIds = new Set(candidates.rows.map((candidate) => candidate.message_id));
    const recheckIds = queuedIds.filter((id) => !eligibleIds.has(id));
    if (recheckIds.length > 0) {
      await client.query(
        `UPDATE public.imap_thread_work_queue
         SET reason = 'delivery_evidence_recheck',
             attempts = 0,
             available_at = now(),
             last_error = NULL,
             enqueued_at = now(),
             updated_at = now()
         WHERE account_id = $1
           AND message_id = ANY($2::uuid[])
           AND reason = $3`,
        [accountId, recheckIds, DELIVERY_EVIDENCE_BRIDGE_REASON]
      );
    }
    if (candidates.rows.length === 0) return 0;

    const changed = await client.query<{ count: string }>(
      `WITH candidates AS MATERIALIZED (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS candidate(
           message_id uuid,
           authored_delivery_sha256 text
         )
       ), repaired AS (
         UPDATE public.imap_message_bodies body
         SET authored_delivery_sha256 = candidates.authored_delivery_sha256
         FROM candidates
         WHERE body.message_id = candidates.message_id
           AND body.message_id = ANY($2::uuid[])
           AND body.authored_delivery_sha256 IS NULL
         RETURNING body.message_id
       )
       SELECT count(*)::text AS count FROM repaired`,
      [JSON.stringify(candidates.rows), candidates.rows.map((candidate) => candidate.message_id)]
    );
    return Number(changed.rows[0]?.count ?? 0);
  }

  private async backfillLegacyBodyEvidenceBatch(
    client: PgClient,
    accountId: string,
    limit: number
  ): Promise<number> {
    if (limit <= 0) return 0;
    const candidates = await client.query<{
      message_id: string;
      raw_mime_sha256: string | null;
      parsed_delivery_sha256: string | null;
    }>(
      `SELECT body.message_id,
                CASE
                  WHEN body.raw_mime_sha256 IS NULL
                   AND body.raw_mime IS NOT NULL
                   AND NOT body.raw_truncated
                  THEN encode(extensions.digest(body.raw_mime, 'sha256'), 'hex')
                  ELSE body.raw_mime_sha256
                END AS raw_mime_sha256,
                CASE
                  WHEN body.parsed_delivery_sha256 IS NULL
                   AND body.raw_mime_sha256 IS NULL
                   AND body.raw_mime IS NULL
                   AND NOT body.raw_truncated
                   AND body.raw_bytes > 0
                   AND message.from_email IS NOT NULL
                   AND body.headers_json ? 'message-id'
                   AND body.headers_json ? 'from'
                   AND cardinality(
                     coalesce(message.to_emails, '{}'::text[]) ||
                     coalesce(message.cc_emails, '{}'::text[]) ||
                     coalesce(message.bcc_emails, '{}'::text[])
                   ) > 0
                   AND body.threading_payload_sha256 IS NOT NULL
                  THEN encode(extensions.digest(convert_to(jsonb_build_object(
                    'subject', message.subject,
                    'from_email', message.from_email,
                    'to_emails', message.to_emails,
                    'cc_emails', message.cc_emails,
                    'bcc_emails', message.bcc_emails,
                    'size_bytes', message.size_bytes,
                    'raw_bytes', body.raw_bytes,
                    'threading_payload_sha256', body.threading_payload_sha256,
                    'headers_json', body.headers_json,
                    'mime_structure', body.mime_structure,
                    'parser_warnings', body.parser_warnings
                  )::text, 'UTF8'), 'sha256'), 'hex')
                  ELSE body.parsed_delivery_sha256
                END AS parsed_delivery_sha256
         FROM public.imap_message_bodies body
         JOIN public.imap_messages message ON message.id = body.message_id
         WHERE message.account_id = $1
           AND (
             (body.raw_mime_sha256 IS NULL AND body.raw_mime IS NOT NULL AND NOT body.raw_truncated)
             OR
             (
               body.parsed_delivery_sha256 IS NULL
               AND body.raw_mime_sha256 IS NULL
               AND NOT body.raw_truncated
               AND body.raw_bytes > 0
               AND message.from_email IS NOT NULL
               AND body.headers_json ? 'message-id'
               AND body.headers_json ? 'from'
               AND cardinality(
                 coalesce(message.to_emails, '{}'::text[]) ||
                 coalesce(message.cc_emails, '{}'::text[]) ||
                 coalesce(message.bcc_emails, '{}'::text[])
               ) > 0
               AND body.threading_payload_sha256 IS NOT NULL
             )
           )
         ORDER BY body.message_id
         LIMIT $2
         FOR UPDATE OF body`,
      [accountId, limit]
    );
    if (candidates.rows.length === 0) return 0;

    const changed = await client.query<{ count: string }>(
      `WITH candidates AS MATERIALIZED (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS candidate(
           message_id uuid,
           raw_mime_sha256 text,
           parsed_delivery_sha256 text
         )
       ), repaired AS (
         UPDATE public.imap_message_bodies body
         SET raw_mime_sha256 = candidates.raw_mime_sha256,
             parsed_delivery_sha256 = candidates.parsed_delivery_sha256
         FROM candidates
         WHERE body.message_id = candidates.message_id
           AND body.message_id = ANY($2::uuid[])
         RETURNING body.message_id
       )
       SELECT count(*)::text AS count FROM repaired`,
      [JSON.stringify(candidates.rows), candidates.rows.map((candidate) => candidate.message_id)]
    );
    return Number(changed.rows[0]?.count ?? 0);
  }

  /**
   * Close the tiny race between the pre-lock hash pass and acquiring the state
   * barrier. This is read-only by design, so an older writer that already holds a
   * body row lock can finish its trigger instead of deadlocking with us.
   */
  private async hasQueuedBodyEvidenceGap(client: PgClient, accountId: string): Promise<boolean> {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM public.imap_thread_work_queue queue
         JOIN public.imap_thread_runs run
           ON run.id = queue.run_id
          AND run.status = ANY($2::text[])
         JOIN public.imap_message_bodies body ON body.message_id = queue.message_id
         JOIN public.imap_messages message ON message.id = body.message_id
         WHERE queue.account_id = $1
           AND (
             (
               queue.reason = $3
               AND body.authored_delivery_sha256 IS NULL
               AND NOT body.raw_truncated
               AND body.raw_bytes > 0
               AND message.from_email IS NOT NULL
               AND body.headers_json ? 'message-id'
               AND body.headers_json ? 'from'
               AND body.headers_json ? 'date'
               AND cardinality(
                 coalesce(message.to_emails, '{}'::text[]) ||
                 coalesce(message.cc_emails, '{}'::text[]) ||
                 coalesce(message.bcc_emails, '{}'::text[])
               ) > 0
               AND body.threading_payload_sha256 IS NOT NULL
               AND body.mime_structure IS NOT NULL
               AND body.structured_evidence_complete
               AND body.structured_evidence_sha256 IS NOT NULL
             )
             OR
             (body.raw_mime_sha256 IS NULL AND body.raw_mime IS NOT NULL AND NOT body.raw_truncated)
             OR
             (
               body.parsed_delivery_sha256 IS NULL
               AND body.raw_mime_sha256 IS NULL
               AND NOT body.raw_truncated
               AND body.raw_bytes > 0
               AND message.from_email IS NOT NULL
               AND body.headers_json ? 'message-id'
               AND body.headers_json ? 'from'
               AND cardinality(
                 coalesce(message.to_emails, '{}'::text[]) ||
                 coalesce(message.cc_emails, '{}'::text[]) ||
                 coalesce(message.bcc_emails, '{}'::text[])
               ) > 0
               AND body.threading_payload_sha256 IS NOT NULL
             )
           )
         LIMIT 1
       ) AS exists`,
      [accountId, [...LIVE_RUN_STATUSES], DELIVERY_EVIDENCE_BRIDGE_REASON]
    );
    return result.rows[0]?.exists ?? false;
  }

  private async processStrongPage(
    client: PgClient,
    run: ThreadRun,
    batchSize: number,
    closureLimits: ClosureLimits,
    requestedBy: string,
    attempted: AttemptedThreadWork
  ): Promise<ThreadingRunResult> {
    const page = await this.loadPhysicalPage(client, run, batchSize);
    if (page.length === 0) {
      const next = await this.setRunStage(client, run, "subject", null);
      return this.resultForRun(run.account_id, next);
    }
    const seedIds = page.map((row) => row.id);
    attempted(seedIds, true);
    const closure = await this.expandClosure(client, run, seedIds, closureLimits);
    const assignments = this.computeAssignments(run, closure.inputs, { allowSubjectFallback: false });
    const persisted = await this.persistAssignments(client, run, assignments, closure.inputs, {
      operationType: "build_batch",
      requestedBy,
      reason: "bounded protocol graph build",
      subjectFallbackEnabled: false,
      enqueueSubjectWork: true
    });
    const removed = await this.deleteRunQueue(client, run.id, closure.inputs.map((input) => input.id));
    const last = page.at(-1) as PhysicalPageRow;
    const nextStage = page.length < batchSize ? "subject" : "strong";
    const updated = await this.setRunStage(client, run, nextStage, nextStage === "subject" ? null : cursorFrom(last));
    return this.resultForRun(run.account_id, updated, {
      operationId: persisted.operationId,
      operationType: "build_batch",
      generation: persisted.generation,
      messagesConsidered: closure.inputs.length,
      assignmentsChanged: persisted.changed,
      queueItemsProcessed: removed
    });
  }

  private async processSubjectWork(
    client: PgClient,
    run: ThreadRun,
    batchSize: number,
    closureLimits: ClosureLimits,
    maxBucket: number,
    requestedBy: string,
    attempted: AttemptedThreadWork
  ): Promise<ThreadingRunResult> {
    const prunedInert = await this.pruneInertSubjectWork(client, run, batchSize);
    if (prunedInert > 0) {
      const operationType = run.status === "building" ? "build_batch" : "incremental";
      const operation = await this.insertOperation(client, {
        run,
        type: operationType,
        requestedBy,
        reason: "subject buckets with fewer than two eligible deliveries cannot produce a fallback edge",
        summary: { inert_subject_buckets_pruned: prunedInert, assignments_changed: 0 }
      });
      return this.resultForRun(run.account_id, run, {
        operationId: operation,
        operationType,
        queueItemsProcessed: prunedInert
      });
    }
    const work = await client.query<{ subject_key: string }>(
      `SELECT subject_key FROM public.imap_thread_subject_work
       WHERE run_id = $1 AND available_at <= now()
       ORDER BY enqueued_at, subject_key LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [run.id]
    );
    const subjectKey = work.rows[0]?.subject_key;
    if (!subjectKey) {
      const hasAny = await client.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM public.imap_thread_subject_work WHERE run_id = $1) AS exists",
        [run.id]
      );
      if (hasAny.rows[0]?.exists) return this.resultForRun(run.account_id, run);
      if (run.status === "building" && run.stage === "subject") {
        const next = await this.setRunStage(client, run, "catchup", null);
        return this.resultForRun(run.account_id, next);
      }
      return this.resultForRun(run.account_id, run);
    }
    const members = await client.query<{ message_id: string }>(
      `SELECT message_id FROM public.imap_thread_assignments
       WHERE run_id = $1 AND subject_key = $2
       ORDER BY message_id LIMIT $3`,
      [run.id, subjectKey, maxBucket + 1]
    );
    if (members.rows.length > maxBucket) {
      // A bucket can cross the cap after an earlier, smaller bucket created a
      // weak merge. Ambiguity must fail closed: dissolve those old weak edges
      // in bounded components before declaring the bucket skipped.
      const staleWeak = await client.query<{ message_id: string }>(
        `SELECT message_id
         FROM public.imap_thread_assignments
         WHERE run_id = $1
           AND subject_key = $2
           AND assignment_method = 'subject_fallback'
         ORDER BY message_id
         LIMIT $3`,
        [run.id, subjectKey, batchSize]
      );
      if (staleWeak.rows.length > 0) {
        const staleIds = staleWeak.rows.map((row) => row.message_id);
        attempted(staleIds, false);
        const closure = await this.expandClosure(client, run, staleIds, {
          ...closureLimits,
          maxMessages: Math.max(closureLimits.maxMessages, maxBucket)
        });
        const assignments = this.computeAssignments(run, closure.inputs, { allowSubjectFallback: false });
        const operationType = run.status === "building" ? "build_batch" : "incremental";
        const persisted = await this.persistAssignments(client, run, assignments, closure.inputs, {
          operationType,
          requestedBy,
          reason: "oversized subject bucket invalidated prior weak merge",
          subjectFallbackEnabled: false,
          enqueueSubjectWork: false
        });
        const remainingWeak = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM public.imap_thread_assignments
             WHERE run_id = $1 AND subject_key = $2 AND assignment_method = 'subject_fallback'
           ) AS exists`,
          [run.id, subjectKey]
        );
        if (!remainingWeak.rows[0]?.exists) {
          await client.query(
            "DELETE FROM public.imap_thread_subject_work WHERE run_id = $1 AND subject_key = $2",
            [run.id, subjectKey]
          );
          await this.recordOversizedSubjectBucket(client, run.id);
        }
        return this.resultForRun(run.account_id, run, {
          operationId: persisted.operationId,
          operationType,
          generation: persisted.generation,
          messagesConsidered: closure.inputs.length,
          assignmentsChanged: persisted.changed,
          subjectFallbackEnabled: false
        });
      }
      await client.query(
        "DELETE FROM public.imap_thread_subject_work WHERE run_id = $1 AND subject_key = $2",
        [run.id, subjectKey]
      );
      await this.recordOversizedSubjectBucket(client, run.id);
      const operationType = run.status === "building" ? "build_batch" : "incremental";
      const operation = await this.insertOperation(client, {
        run,
        type: operationType,
        requestedBy,
        reason: "subject bucket conservatively skipped above safety cap",
        summary: { subject_key: subjectKey, candidate_count_lower_bound: members.rows.length, assignments_changed: 0 }
      });
      return this.resultForRun(run.account_id, run, {
        operationId: operation,
        operationType
      });
    }
    const ids = members.rows.map((row) => row.message_id);
    attempted(ids, false);
    const closure = await this.expandClosure(client, run, ids, closureLimits);
    const assignments = this.computeAssignments(run, closure.inputs, { allowSubjectFallback: true });
    const operationType = run.status === "building" ? "build_batch" : "incremental";
    const persisted = await this.persistAssignments(client, run, assignments, closure.inputs, {
      operationType,
      requestedBy,
      reason: "bounded exact-subject fallback pass",
      subjectFallbackEnabled: true,
      enqueueSubjectWork: false
    });
    await client.query(
      "DELETE FROM public.imap_thread_subject_work WHERE run_id = $1 AND subject_key = $2",
      [run.id, subjectKey]
    );
    return this.resultForRun(run.account_id, run, {
      operationId: persisted.operationId,
      operationType,
      generation: persisted.generation,
      messagesConsidered: closure.inputs.length,
      assignmentsChanged: persisted.changed,
      subjectFallbackEnabled: true
    });
  }

  private async processCatchup(
    client: PgClient,
    run: ThreadRun,
    batchSize: number,
    closureLimits: ClosureLimits,
    maxBucket: number,
    requestedBy: string,
    attempted: AttemptedThreadWork
  ): Promise<ThreadingRunResult> {
    if (await this.runHasReadyQueue(client, run.id)) {
      return this.processDirtyQueue(client, run, batchSize, closureLimits, requestedBy, attempted);
    }
    if (await this.runHasReadySubjectWork(client, run.id)) {
      return this.processSubjectWork(client, run, batchSize, closureLimits, maxBucket, requestedBy, attempted);
    }
    if (await this.runHasAnyWork(client, run.id)) return this.resultForRun(run.account_id, run);
    if ((await this.enqueueMissingAssignments(client, run, batchSize)) > 0) {
      return this.processDirtyQueue(client, run, batchSize, closureLimits, requestedBy, attempted);
    }
    const ready = await this.markRunReady(client, run);
    return this.resultForRun(run.account_id, ready, { ready: true });
  }

  private async processLiveRun(
    client: PgClient,
    run: ThreadRun,
    batchSize: number,
    closureLimits: ClosureLimits,
    maxBucket: number,
    requestedBy: string,
    attempted: AttemptedThreadWork
  ): Promise<ThreadingRunResult> {
    if (await this.runHasReadyQueue(client, run.id)) {
      return this.processDirtyQueue(client, run, batchSize, closureLimits, requestedBy, attempted);
    }
    if (await this.runHasReadySubjectWork(client, run.id)) {
      return this.processSubjectWork(client, run, batchSize, closureLimits, maxBucket, requestedBy, attempted);
    }
    if (run.status === "ready" && (await this.enqueueMissingAssignments(client, run, batchSize)) > 0) {
      return this.processDirtyQueue(client, run, batchSize, closureLimits, requestedBy, attempted);
    }
    if (run.status === "ready") await this.markRunCoverageVerified(client, run);
    return this.resultForRun(run.account_id, run, { ready: true, active: run.status === "active" });
  }

  private async processDirtyQueue(
    client: PgClient,
    run: ThreadRun,
    batchSize: number,
    closureLimits: ClosureLimits,
    requestedBy: string,
    attempted: AttemptedThreadWork
  ): Promise<ThreadingRunResult> {
    const work = await client.query<{ message_id: string }>(
      `SELECT message_id FROM public.imap_thread_work_queue
       WHERE run_id = $1 AND available_at <= now()
       ORDER BY enqueued_at, message_id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [run.id, batchSize]
    );
    const ids = work.rows.map((row) => row.message_id);
    if (ids.length === 0) return this.resultForRun(run.account_id, run);
    attempted(ids, true);
    const closure = await this.expandClosure(client, run, ids, closureLimits);
    const assignments = this.computeAssignments(run, closure.inputs, { allowSubjectFallback: false });
    const persisted = await this.persistAssignments(client, run, assignments, closure.inputs, {
      operationType: "incremental",
      requestedBy,
      reason: "threading inputs changed",
      subjectFallbackEnabled: false,
      enqueueSubjectWork: true
    });
    const removed = await this.deleteRunQueue(client, run.id, closure.inputs.map((input) => input.id));
    return this.resultForRun(run.account_id, run, {
      operationId: persisted.operationId,
      operationType: "incremental",
      generation: persisted.generation,
      messagesConsidered: closure.inputs.length,
      assignmentsChanged: persisted.changed,
      queueItemsProcessed: removed
    });
  }

  private async expandClosure(
    client: PgClient,
    run: ThreadRun,
    seedIds: string[],
    limits: ClosureLimits
  ): Promise<{ inputs: ThreadingMessageInput[] }> {
    const ids = new Set(seedIds);
    const loadedInputs = new Map<string, ThreadingMessageInput>();
    const loadedStored = new Map<string, StoredAssignment>();
    const criteria = emptyCriteria();
    let evidenceBytes = 0;

    for (;;) {
      if (ids.size > limits.maxMessages) throw new ThreadingClosureLimitError(limits.maxMessages);
      const toLoad = [...ids].filter((id) => !loadedInputs.has(id));
      if (toLoad.length > 0) {
        evidenceBytes += await this.measureInputEvidenceBytes(client, toLoad);
        if (evidenceBytes > limits.maxEvidenceBytes) {
          throw new ThreadingEvidenceLimitError("bytes", limits.maxEvidenceBytes);
        }
        const inputs = await this.loadInputs(client, toLoad);
        const stored = await this.loadStoredAssignments(client, run.id, toLoad);
        for (const input of inputs) {
          loadedInputs.set(input.id, input);
          addInputCriteria(criteria, input, run.algorithm_version);
        }
        for (const assignment of stored) loadedStored.set(assignment.message_id, assignment);
      }
      for (const assignment of loadedStored.values()) addStoredCriteria(criteria, assignment);
      for (const assignment of this.computeAssignments(run, [...loadedInputs.values()], { allowSubjectFallback: false })) {
        addComputedCriteria(criteria, assignment);
      }

      const criteriaKeyCount = criteria.conversationIds.size + criteria.deliveryKeys.size +
        criteria.referenceHashes.size + criteria.deliveryFingerprintHashes.size +
        criteria.providerThreadHashes.size;
      if (criteriaKeyCount > limits.maxCriteriaKeys) {
        throw new ThreadingEvidenceLimitError("criteria", limits.maxCriteriaKeys);
      }
      const remaining = limits.maxMessages - ids.size;
      const candidates = await client.query<{ message_id: string }>(
        `
        SELECT message_id
        FROM public.imap_thread_assignments
        WHERE run_id = $1
          AND NOT (message_id = ANY($7::uuid[]))
          AND (
            conversation_id = ANY($2::text[])
            OR delivery_key = ANY($3::text[])
            OR strict_message_id_hash = ANY($4::text[])
            OR root_reference_hash = ANY($4::text[])
            OR parent_reference_hash = ANY($4::text[])
            OR reference_hashes && $4::text[]
            OR provider_thread_hash = ANY($5::text[])
            OR delivery_fingerprint_hashes && $6::text[]
          )
        ORDER BY message_id
        LIMIT $8
        `,
        [
          run.id,
          [...criteria.conversationIds],
          [...criteria.deliveryKeys],
          [...criteria.referenceHashes],
          [...criteria.providerThreadHashes],
          [...criteria.deliveryFingerprintHashes],
          [...ids],
          remaining + 1
        ]
      );
      const newIds = candidates.rows.filter((row) => !ids.has(row.message_id));
      if (newIds.length > remaining) throw new ThreadingClosureLimitError(limits.maxMessages);
      for (const row of newIds) ids.add(row.message_id);
      if (newIds.length === 0) break;
    }

    const missing = [...ids].filter((id) => !loadedInputs.has(id));
    if (missing.length > 0) {
      for (const input of await this.loadInputs(client, missing)) loadedInputs.set(input.id, input);
    }
    return { inputs: [...loadedInputs.values()].sort((a, b) => compareText(a.id, b.id)) };
  }

  private async measureInputEvidenceBytes(client: PgClient, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await client.query<{ bytes: string }>(
      `SELECT coalesce(sum(
         octet_length(coalesce(message.rfc_message_id, '')) +
         octet_length(coalesce(message.references_header, '')) +
         octet_length(coalesce(message.in_reply_to, '')) +
         octet_length(coalesce(message.headers_json::text, '')) +
         octet_length(coalesce(message.provider_message_id, '')) +
         octet_length(coalesce(message.provider_message_id_namespace, '')) +
         octet_length(coalesce(message.provider_thread_id, '')) +
         octet_length(coalesce(message.provider_thread_id_namespace, '')) +
         octet_length(coalesce(message.subject, '')) +
         octet_length(coalesce(message.from_email, '')) +
         octet_length(coalesce(array_to_string(message.to_emails, ','), '')) +
         octet_length(coalesce(array_to_string(message.cc_emails, ','), '')) +
         octet_length(coalesce(array_to_string(message.bcc_emails, ','), '')) +
         octet_length(coalesce(body.headers_json::text, ''))
       ), 0)::text AS bytes
       FROM public.imap_messages message
       LEFT JOIN public.imap_message_bodies body ON body.message_id = message.id
       WHERE message.id = ANY($1::uuid[])`,
      [ids]
    );
    return Number(result.rows[0]?.bytes ?? 0);
  }

  private async loadInputs(client: PgClient, ids: string[]): Promise<ThreadingMessageInput[]> {
    if (ids.length === 0) return [];
    const result = await client.query<ThreadingMessageInput>(
      `
      SELECT
        m.id, m.account_id, m.folder_path,
        m.uidvalidity::text AS uidvalidity, m.uid::text AS uid,
        m.rfc_message_id, m.references_header, m.in_reply_to,
        coalesce(body.headers_json, '{}'::jsonb) || m.headers_json AS headers_json,
        m.provider_message_id,
        m.provider_message_id_namespace AS provider_message_namespace,
        m.provider_thread_id,
        m.provider_thread_id_namespace AS provider_thread_namespace,
        m.internal_date, m.size_bytes::text AS size_bytes,
        body.raw_mime_sha256 AS raw_mime_hash,
        body.parsed_delivery_sha256 AS delivery_fingerprint,
        body.authored_delivery_sha256 AS authored_delivery_fingerprint,
        m.subject, m.from_email,
        coalesce(m.to_emails, '{}'::text[]) AS to_emails,
        coalesce(m.cc_emails, '{}'::text[]) AS cc_emails,
        coalesce(m.bcc_emails, '{}'::text[]) AS bcc_emails
      FROM public.imap_messages m
      LEFT JOIN public.imap_message_bodies body ON body.message_id = m.id
      WHERE m.id = ANY($1::uuid[])
      ORDER BY m.id
      `,
      [ids]
    );
    return result.rows;
  }

  private async loadStoredAssignments(client: PgClient, runId: string, ids: string[]): Promise<StoredAssignment[]> {
    if (ids.length === 0) return [];
    const result = await client.query<StoredAssignment>(
      `
      SELECT run_id, message_id, account_id, delivery_key,
             strict_message_id, strict_message_id_hash, conversation_id,
             root_reference, root_reference_hash, parent_reference, parent_reference_hash,
             parent_delivery_key, reference_ids, reference_hashes,
             delivery_fingerprint_hashes,
             subject_base, subject_key, participant_edge_hashes,
             provider_thread_key, provider_thread_hash, assignment_method,
             confidence, is_provisional, subject_fallback_eligible,
             algorithm_version, input_hash, generation::text AS generation, evidence
      FROM public.imap_thread_assignments
      WHERE run_id = $1 AND message_id = ANY($2::uuid[])
      ORDER BY message_id
      `,
      [runId, ids]
    );
    return result.rows;
  }

  private async persistAssignments(
    client: PgClient,
    run: ThreadRun,
    assignments: ThreadingAssignment[],
    inputs: ThreadingMessageInput[],
    options: {
      operationType: "build_batch" | "incremental";
      requestedBy: string;
      reason: string;
      subjectFallbackEnabled: boolean;
      enqueueSubjectWork: boolean;
    }
  ): Promise<{ operationId: string; generation: string | null; changed: number }> {
    const ids = assignments.map((assignment) => assignment.physical_message_id);
    const current = await this.loadStoredAssignments(client, run.id, ids);
    const currentById = new Map(current.map((row) => [row.message_id, row]));
    const inputsById = new Map(inputs.map((input) => [input.id, input]));
    const fromGeneration = await this.currentGeneration(client, run.id);
    const candidateGeneration = (BigInt(fromGeneration) + 1n).toString();
    const candidates = assignments.map((assignment) => assignmentRecord(run, assignment, candidateGeneration, inputsById));
    const changed = candidates.filter((candidate) => !sameAssignment(currentById.get(candidate.message_id), candidate));
    const generation = changed.length > 0 ? candidateGeneration : null;
    const operationId = await this.insertOperation(client, {
      run,
      type: options.operationType,
      requestedBy: options.requestedBy,
      reason: options.reason,
      fromGeneration,
      toGeneration: generation,
      parameters: { subject_fallback_enabled: options.subjectFallbackEnabled },
      summary: {
        messages_considered: inputs.length,
        assignments_changed: changed.length,
        assignments_unchanged: assignments.length - changed.length
      }
    });
    if (changed.length > 0) {
      await this.upsertAssignments(client, changed);
      // Build rows are themselves a disposable, versioned snapshot; duplicating
      // every one into JSON history on every rebuild is pure write amplification.
      // Only the latest material change to the active projection is
      // rollbackable. Keep that one reversible delta, not an unbounded audit
      // log. Candidate and standby projections cannot use incremental rollback.
      if (options.operationType === "incremental" && run.status === "active") {
        await this.insertHistory(
          client,
          operationId,
          run,
          changed.map((record) => {
            const previous = currentById.get(record.message_id);
            return {
              message_id: record.message_id,
              change_type: previous ? "update" as const : "insert" as const,
              previous_assignment: previous ? snapshot(previous) : null,
              next_assignment: snapshot(record)
            };
          })
        );
        await this.retainOnlyOperationHistory(client, run.account_id, operationId);
      }
      if (options.enqueueSubjectWork) {
        const keys = new Set<string>();
        for (const record of changed) {
          const previous = currentById.get(record.message_id);
          if (record.subject_fallback_eligible && record.subject_key) keys.add(record.subject_key);
          if (previous?.assignment_method === "subject_fallback" && previous.subject_key) keys.add(previous.subject_key);
        }
        await this.enqueueSubjectWork(client, run, [...keys]);
      }
    }
    await this.enqueueDeliveryEvidenceBridges(
      client,
      run,
      deliveryEvidenceBridgeIds(assignments, inputs)
    );
    return { operationId, generation, changed: changed.length };
  }

  private async upsertAssignments(client: PgClient, records: AssignmentRecord[]): Promise<void> {
    for (const batch of chunk(records)) {
      await client.query(
        `
        WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS value(
            run_id uuid, message_id uuid, account_id uuid, delivery_key text,
            strict_message_id text, strict_message_id_hash text, conversation_id text,
            root_reference text, root_reference_hash text,
            parent_reference text, parent_reference_hash text, parent_delivery_key text,
            reference_ids text[], reference_hashes text[], delivery_fingerprint_hashes text[],
            subject_base text, subject_key text,
            participant_edge_hashes text[], provider_thread_key text, provider_thread_hash text,
            assignment_method text, confidence text, is_provisional boolean,
            subject_fallback_eligible boolean, algorithm_version integer,
            input_hash text, generation bigint, evidence jsonb
          )
        )
        INSERT INTO public.imap_thread_assignments (
          run_id, message_id, account_id, delivery_key,
          strict_message_id, strict_message_id_hash, conversation_id,
          root_reference, root_reference_hash, parent_reference, parent_reference_hash,
          parent_delivery_key, reference_ids, reference_hashes,
          delivery_fingerprint_hashes,
          subject_base, subject_key, participant_edge_hashes,
          provider_thread_key, provider_thread_hash, assignment_method,
          confidence, is_provisional, subject_fallback_eligible,
          algorithm_version, input_hash, generation, evidence, computed_at
        )
        SELECT run_id, message_id, account_id, delivery_key,
          strict_message_id, strict_message_id_hash, conversation_id,
          root_reference, root_reference_hash, parent_reference, parent_reference_hash,
          parent_delivery_key, reference_ids, reference_hashes,
          delivery_fingerprint_hashes,
          subject_base, subject_key, participant_edge_hashes,
          provider_thread_key, provider_thread_hash, assignment_method,
          confidence, is_provisional, subject_fallback_eligible,
          algorithm_version, input_hash, generation, evidence, now()
        FROM incoming
        ON CONFLICT (run_id, message_id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          delivery_key = EXCLUDED.delivery_key,
          strict_message_id = EXCLUDED.strict_message_id,
          strict_message_id_hash = EXCLUDED.strict_message_id_hash,
          conversation_id = EXCLUDED.conversation_id,
          root_reference = EXCLUDED.root_reference,
          root_reference_hash = EXCLUDED.root_reference_hash,
          parent_reference = EXCLUDED.parent_reference,
          parent_reference_hash = EXCLUDED.parent_reference_hash,
          parent_delivery_key = EXCLUDED.parent_delivery_key,
          reference_ids = EXCLUDED.reference_ids,
          reference_hashes = EXCLUDED.reference_hashes,
          delivery_fingerprint_hashes = EXCLUDED.delivery_fingerprint_hashes,
          subject_base = EXCLUDED.subject_base,
          subject_key = EXCLUDED.subject_key,
          participant_edge_hashes = EXCLUDED.participant_edge_hashes,
          provider_thread_key = EXCLUDED.provider_thread_key,
          provider_thread_hash = EXCLUDED.provider_thread_hash,
          assignment_method = EXCLUDED.assignment_method,
          confidence = EXCLUDED.confidence,
          is_provisional = EXCLUDED.is_provisional,
          subject_fallback_eligible = EXCLUDED.subject_fallback_eligible,
          algorithm_version = EXCLUDED.algorithm_version,
          input_hash = EXCLUDED.input_hash,
          generation = EXCLUDED.generation,
          evidence = EXCLUDED.evidence,
          computed_at = now()
        `,
        [JSON.stringify(batch)]
      );
    }
  }

  private async insertHistory(client: PgClient, operationId: string, run: ThreadRun, entries: HistoryEntry[]): Promise<void> {
    for (const batch of chunk(entries)) {
      await client.query(
        `
        WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($4::jsonb) AS value(
            message_id uuid, change_type text,
            previous_assignment jsonb, next_assignment jsonb
          )
        )
        INSERT INTO public.imap_thread_assignment_history (
          operation_id, run_id, account_id, message_id, change_type,
          previous_assignment, next_assignment
        )
        SELECT $1, $2, $3, message_id, change_type, previous_assignment, next_assignment
        FROM incoming
        ON CONFLICT (operation_id, message_id) DO NOTHING
        `,
        [operationId, run.id, run.account_id, JSON.stringify(batch)]
      );
    }
  }

  private async retainOnlyOperationHistory(
    client: PgClient,
    accountId: string,
    operationId: string
  ): Promise<void> {
    await client.query(
      `DELETE FROM public.imap_thread_assignment_history
       WHERE account_id = $1 AND operation_id <> $2`,
      [accountId, operationId]
    );
  }

  private async clearAssignmentHistory(client: PgClient, accountId: string): Promise<void> {
    await client.query(
      "DELETE FROM public.imap_thread_assignment_history WHERE account_id = $1",
      [accountId]
    );
  }

  private async insertOperation(
    client: PgClient,
    input: {
      run: ThreadRun;
      type: OperationType;
      requestedBy: string;
      reason: string;
      fromGeneration?: string | null;
      toGeneration?: string | null;
      reversesOperationId?: string | null;
      parameters?: Record<string, unknown>;
      summary?: Record<string, unknown>;
      status?: "succeeded" | "failed";
    }
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `
      INSERT INTO public.imap_thread_operations (
        run_id, account_id, operation_type, status, algorithm_version,
        from_generation, to_generation, reverses_operation_id,
        requested_by, reason, parameters, summary, started_at, completed_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10, $11::jsonb, $12::jsonb, now(), now()
      ) RETURNING id
      `,
      [
        input.run.id,
        input.run.account_id,
        input.type,
        input.status ?? "succeeded",
        input.run.algorithm_version,
        input.fromGeneration ?? null,
        input.toGeneration ?? null,
        input.reversesOperationId ?? null,
        input.requestedBy,
        input.reason,
        JSON.stringify(input.parameters ?? {}),
        JSON.stringify(input.summary ?? {})
      ]
    );
    return result.rows[0].id;
  }

  private async enqueueSubjectWork(client: PgClient, run: ThreadRun, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await client.query(
      `
      INSERT INTO public.imap_thread_subject_work (run_id, account_id, subject_key)
      SELECT $1, $2, key FROM unnest($3::text[]) AS key
      ON CONFLICT (run_id, subject_key) DO UPDATE SET
        attempts = 0, available_at = now(), last_error = NULL,
        enqueued_at = now(), updated_at = now()
      `,
      [run.id, run.account_id, keys]
    );
  }

  private async enqueueDeliveryEvidenceBridges(
    client: PgClient,
    run: ThreadRun,
    ids: string[]
  ): Promise<void> {
    if (ids.length === 0) return;
    await client.query(
      `INSERT INTO public.imap_thread_work_queue (
         run_id, message_id, account_id, reason, attempts, available_at,
         last_error, enqueued_at, updated_at
       )
       SELECT $1, message.id, $2, $3, 0, now(), NULL, now(), now()
       FROM public.imap_messages message
       JOIN public.imap_message_bodies body ON body.message_id = message.id
       WHERE message.id = ANY($4::uuid[])
         AND message.account_id = $2
         AND body.authored_delivery_sha256 IS NULL
         AND NOT body.raw_truncated
         AND body.raw_bytes > 0
         AND message.from_email IS NOT NULL
         AND body.headers_json ? 'message-id'
         AND body.headers_json ? 'from'
         AND body.headers_json ? 'date'
         AND cardinality(
           coalesce(message.to_emails, '{}'::text[]) ||
           coalesce(message.cc_emails, '{}'::text[]) ||
           coalesce(message.bcc_emails, '{}'::text[])
         ) > 0
         AND body.threading_payload_sha256 IS NOT NULL
         AND body.mime_structure IS NOT NULL
         AND body.structured_evidence_complete
         AND body.structured_evidence_sha256 IS NOT NULL
       ON CONFLICT (run_id, message_id) DO UPDATE SET
         reason = EXCLUDED.reason, attempts = 0, available_at = now(),
         last_error = NULL, enqueued_at = now(), updated_at = now()`,
      [run.id, run.account_id, DELIVERY_EVIDENCE_BRIDGE_REASON, ids]
    );
  }

  private async pruneInertSubjectWork(client: PgClient, run: ThreadRun, limit: number): Promise<number> {
    const result = await client.query<{ count: string }>(
      `WITH candidates AS MATERIALIZED (
         SELECT work.subject_key
         FROM public.imap_thread_subject_work work
         WHERE work.run_id = $1
           AND work.available_at <= now()
           AND NOT EXISTS (
             SELECT 1
             FROM public.imap_thread_assignments existing_weak
             WHERE existing_weak.run_id = work.run_id
               AND existing_weak.subject_key = work.subject_key
               AND existing_weak.assignment_method = 'subject_fallback'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM (
               SELECT eligible.delivery_key
               FROM public.imap_thread_assignments eligible
               WHERE eligible.run_id = work.run_id
                 AND eligible.subject_key = work.subject_key
                 AND eligible.subject_fallback_eligible
               GROUP BY eligible.delivery_key
               LIMIT 1
               OFFSET 1
             ) second_eligible_delivery
           )
         ORDER BY work.enqueued_at, work.subject_key
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       ), removed AS (
         DELETE FROM public.imap_thread_subject_work work
         USING candidates
         WHERE work.run_id = $1
           AND work.subject_key = candidates.subject_key
           AND NOT EXISTS (
             SELECT 1
             FROM public.imap_thread_assignments existing_weak
             WHERE existing_weak.run_id = work.run_id
               AND existing_weak.subject_key = work.subject_key
               AND existing_weak.assignment_method = 'subject_fallback'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM (
               SELECT eligible.delivery_key
               FROM public.imap_thread_assignments eligible
               WHERE eligible.run_id = work.run_id
                 AND eligible.subject_key = work.subject_key
                 AND eligible.subject_fallback_eligible
               GROUP BY eligible.delivery_key
               LIMIT 1
               OFFSET 1
             ) second_eligible_delivery
           )
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM removed`,
      [run.id, limit]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async enqueueMissingAssignments(client: PgClient, run: ThreadRun, limit: number): Promise<number> {
    const result = await client.query<{ count: string }>(
      `WITH missing AS MATERIALIZED (
         SELECT message.id
         FROM public.imap_messages message
         LEFT JOIN public.imap_thread_assignments assignment
           ON assignment.run_id = $1
          AND assignment.message_id = message.id
         WHERE message.account_id = $2
           AND assignment.message_id IS NULL
         ORDER BY message.id
         LIMIT $3
       ), enqueued AS (
         INSERT INTO public.imap_thread_work_queue (
           run_id, message_id, account_id, reason, attempts, available_at,
           last_error, enqueued_at, updated_at
         )
         SELECT $1, missing.id, $2, 'coverage_repair', 0, now(), NULL, now(), now()
         FROM missing
         ON CONFLICT (run_id, message_id) DO UPDATE SET
           reason = EXCLUDED.reason, attempts = 0, available_at = now(),
           last_error = NULL, enqueued_at = now(), updated_at = now()
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM enqueued`,
      [run.id, run.account_id, limit]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async deleteRunQueue(client: PgClient, runId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await client.query<{ count: string }>(
      `WITH removed AS (
         DELETE FROM public.imap_thread_work_queue
         WHERE run_id = $1
           AND message_id = ANY($2::uuid[])
           AND reason <> $3
         RETURNING 1
       ) SELECT count(*)::text AS count FROM removed`,
      [runId, ids, DELIVERY_EVIDENCE_BRIDGE_REASON]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async currentGeneration(client: PgClient, runId: string): Promise<string> {
    const result = await client.query<{ generation: string }>(
      `SELECT coalesce(max(to_generation), 0)::text AS generation
       FROM public.imap_thread_operations WHERE run_id = $1`,
      [runId]
    );
    return result.rows[0]?.generation ?? "0";
  }

  private async loadPhysicalPage(client: PgClient, run: ThreadRun, limit: number): Promise<PhysicalPageRow[]> {
    const result = await client.query<PhysicalPageRow>(
      `
      SELECT id, folder_path, uidvalidity::text AS uidvalidity, uid::text AS uid
      FROM public.imap_messages
      WHERE account_id = $1
        AND ($2::uuid IS NULL OR id > $2::uuid)
      ORDER BY id
      LIMIT $3
      `,
      [run.account_id, run.cursor_message_id, limit]
    );
    return result.rows;
  }

  private async lockState(client: PgClient, accountId: string): Promise<ThreadState> {
    await client.query(
      `INSERT INTO public.imap_thread_state (account_id) VALUES ($1)
       ON CONFLICT (account_id) DO NOTHING`,
      [accountId]
    );
    const result = await client.query<ThreadState>(
      `SELECT account_id, active_run_id, previous_run_id, building_run_id,
              scheduler_cursor, paused_at, pause_reason
       FROM public.imap_thread_state WHERE account_id = $1 FOR UPDATE`,
      [accountId]
    );
    const state = result.rows[0];
    if (!state) throw new Error(`Account not found: ${accountId}`);
    return state;
  }

  private async loadRun(client: PgClient, runId: string): Promise<ThreadRun | null> {
    const result = await client.query<ThreadRun>(
      `SELECT id, account_id, algorithm_version, mode, status, stage, source_run_id,
              cursor_folder_path, cursor_uidvalidity::text, cursor_uid::text, cursor_message_id,
              attempts, available_at, caught_up_revision::text, summary
       FROM public.imap_thread_runs WHERE id = $1`,
      [runId]
    );
    return result.rows[0] ?? null;
  }

  private async createBuildRun(
    client: PgClient,
    state: ThreadState,
    active: ThreadRun | null,
    mode: RunMode,
    requestedBy: string,
    reason: string
  ): Promise<ThreadRun> {
    const result = await client.query<ThreadRun>(
      `
      INSERT INTO public.imap_thread_runs (
        account_id, algorithm_version, mode, status, stage,
        source_run_id, requested_by, reason
      ) VALUES ($1, $2, $3, 'building', 'body_evidence', $4, $5, $6)
      RETURNING id, account_id, algorithm_version, mode, status, stage, source_run_id,
                cursor_folder_path, cursor_uidvalidity::text, cursor_uid::text, cursor_message_id,
                attempts, available_at, caught_up_revision::text, summary
      `,
      [state.account_id, this.currentAlgorithmVersion, mode, active?.id ?? null, requestedBy, reason]
    );
    const run = result.rows[0];
    await client.query(
      "UPDATE public.imap_thread_state SET building_run_id = $2 WHERE account_id = $1",
      [state.account_id, run.id]
    );
    return run;
  }

  private async setRunStage(
    client: PgClient,
    run: ThreadRun,
    stage: RunStage,
    cursor: Pick<ThreadRun, "cursor_folder_path" | "cursor_uidvalidity" | "cursor_uid" | "cursor_message_id"> | null
  ): Promise<ThreadRun> {
    await client.query(
      `UPDATE public.imap_thread_runs
       SET stage = $2,
           cursor_folder_path = $3,
           cursor_uidvalidity = $4,
           cursor_uid = $5,
           cursor_message_id = $6
       WHERE id = $1`,
      [
        run.id,
        stage,
        cursor?.cursor_folder_path ?? null,
        cursor?.cursor_uidvalidity ?? null,
        cursor?.cursor_uid ?? null,
        cursor?.cursor_message_id ?? null
      ]
    );
    return {
      ...run,
      stage,
      cursor_folder_path: cursor?.cursor_folder_path ?? null,
      cursor_uidvalidity: cursor?.cursor_uidvalidity ?? null,
      cursor_uid: cursor?.cursor_uid ?? null,
      cursor_message_id: cursor?.cursor_message_id ?? null
    };
  }

  private async markRunReady(client: PgClient, run: ThreadRun): Promise<ThreadRun> {
    await client.query(
      `UPDATE public.imap_thread_runs
       SET status = 'ready', stage = 'ready', completed_at = now(),
           cursor_folder_path = NULL, cursor_uidvalidity = NULL, cursor_uid = NULL,
           cursor_message_id = NULL,
           summary = jsonb_set(summary, '{coverage_verified}', 'true'::jsonb, true),
           caught_up_revision = coalesce((
             SELECT revision FROM public.imap_thread_evidence_clock WHERE account_id = $2
           ), 0)
       WHERE id = $1`,
      [run.id, run.account_id]
    );
    return { ...run, status: "ready", stage: "ready" };
  }

  private async markRunCoverageVerified(client: PgClient, run: ThreadRun): Promise<void> {
    await client.query(
      `UPDATE public.imap_thread_runs
       SET summary = jsonb_set(summary, '{coverage_verified}', 'true'::jsonb, true)
       WHERE id = $1`,
      [run.id]
    );
  }

  private async markRunCaughtUp(client: PgClient, run: ThreadRun): Promise<void> {
    await client.query(
      `UPDATE public.imap_thread_runs
       SET caught_up_revision = coalesce((
         SELECT revision FROM public.imap_thread_evidence_clock WHERE account_id = $2
       ), 0)
       WHERE id = $1`,
      [run.id, run.account_id]
    );
  }

  private async runHasReadyQueue(client: PgClient, runId: string): Promise<boolean> {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.imap_thread_work_queue
         WHERE run_id = $1 AND available_at <= now()
       ) AS exists`,
      [runId]
    );
    return result.rows[0]?.exists ?? false;
  }

  private async runHasReadySubjectWork(client: PgClient, runId: string): Promise<boolean> {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.imap_thread_subject_work
         WHERE run_id = $1 AND available_at <= now()
       ) AS exists`,
      [runId]
    );
    return result.rows[0]?.exists ?? false;
  }

  private async runHasReadyWork(client: PgClient, runId: string): Promise<boolean> {
    return (await this.runHasReadyQueue(client, runId)) || (await this.runHasReadySubjectWork(client, runId));
  }

  private async runHasAnyWork(client: PgClient, runId: string): Promise<boolean> {
    const result = await client.query<{ exists: boolean }>(
      `SELECT (
         EXISTS (SELECT 1 FROM public.imap_thread_work_queue WHERE run_id = $1)
         OR EXISTS (SELECT 1 FROM public.imap_thread_subject_work WHERE run_id = $1)
       ) AS exists`,
      [runId]
    );
    return result.rows[0]?.exists ?? false;
  }

  private async recordOversizedSubjectBucket(client: PgClient, runId: string): Promise<void> {
    await client.query(
      `UPDATE public.imap_thread_runs
       SET summary = jsonb_set(
         summary,
         '{oversized_subject_buckets}',
         to_jsonb(coalesce((summary->>'oversized_subject_buckets')::integer, 0) + 1),
         true
       )
       WHERE id = $1`,
      [runId]
    );
  }

  private versionSkew(storedVersion: number): ThreadingVersionSkewError {
    return new ThreadingVersionSkewError(storedVersion, [...this.algorithms.keys()].sort((a, b) => a - b));
  }

  private missingExecutor(
    role: "active" | "candidate" | "standby",
    runId: string,
    storedVersion: number,
    accountId: string
  ): ThreadingVersionSkewError {
    const supported = [...this.algorithms.keys()].sort((a, b) => a - b);
    return new ThreadingVersionSkewError(
      storedVersion,
      supported,
      `Threading ${role} run ${runId} for account ${accountId} uses v${storedVersion}, ` +
        `but this binary has no retained executor (available: ${supported.map((version) => `v${version}`).join(", ")})`
    );
  }

  private requireExecutor(
    run: ThreadRun | null,
    role: "active" | "candidate" | "standby"
  ): void {
    if (!run) return;
    const needsExecutor = role === "active"
      ? run.status === "active"
      : role === "candidate"
        ? run.status === "building" || run.status === "ready"
        : run.status === "standby";
    if (!needsExecutor || this.algorithms.has(run.algorithm_version)) return;
    throw this.missingExecutor(role, run.id, run.algorithm_version, run.account_id);
  }

  private computeAssignments(
    run: ThreadRun,
    messages: readonly ThreadingMessageInput[],
    options: ThreadingOptions
  ): ThreadingAssignment[] {
    const executor = this.algorithms.get(run.algorithm_version);
    if (!executor) throw this.versionSkew(run.algorithm_version);
    const assignments = executor(messages, options);
    const expected = new Set(messages.map((message) => message.id));
    if (assignments.length !== expected.size) {
      throw new Error(
        `threading executor v${run.algorithm_version} returned ${assignments.length} assignments for ${expected.size} messages`
      );
    }
    for (const assignment of assignments) {
      if (assignment.algorithm_version !== run.algorithm_version) {
        throw new Error(
          `threading executor v${run.algorithm_version} emitted assignment v${assignment.algorithm_version}`
        );
      }
      if (!expected.delete(assignment.physical_message_id)) {
        throw new Error(
          `threading executor v${run.algorithm_version} emitted an unknown or duplicate physical message id`
        );
      }
    }
    if (expected.size > 0) throw new Error(`threading executor v${run.algorithm_version} omitted physical messages`);
    return assignments;
  }

  private async clearRunWork(client: PgClient, runId: string): Promise<void> {
    await client.query("DELETE FROM public.imap_thread_work_queue WHERE run_id = $1", [runId]);
    await client.query("DELETE FROM public.imap_thread_subject_work WHERE run_id = $1", [runId]);
  }

  private async recordFailureWithClient(
    client: PgClient,
    run: ThreadRun,
    messageIds: string[],
    error: unknown,
    requestedBy: string,
    canSubdivide: boolean
  ): Promise<void> {
    const reason = sanitizedFailure(error);
    const adaptiveBatchSize = canSubdivide && messageIds.length > 1 && (
      error instanceof ThreadingClosureLimitError || error instanceof ThreadingEvidenceLimitError
    )
      ? Math.max(1, Math.floor(messageIds.length / 2))
      : null;
    try {
      await client.query("BEGIN");
      const updated = await client.query<{ id: string }>(
        `UPDATE public.imap_thread_runs
         SET attempts = attempts + 1,
             available_at = CASE WHEN $6::integer IS NOT NULL
               THEN now() + interval '5 seconds'
               ELSE now() + make_interval(
                 secs => least(3600, (5 * power(2, least(attempts, 10)))::integer)
               )
             END,
             last_error = $2,
             summary = CASE WHEN $6::integer IS NULL THEN summary ELSE jsonb_set(
               summary,
               '{adaptive_closure_batch_size}',
               to_jsonb($6::integer),
               true
             ) END
         WHERE id = $1
           AND account_id = $3
           AND algorithm_version = $4
           AND status = $5
         RETURNING id`,
        [run.id, reason, run.account_id, run.algorithm_version, run.status, adaptiveBatchSize]
      );
      if (!updated.rows[0]) {
        await client.query("ROLLBACK");
        return;
      }
      if (messageIds.length > 0) {
        await client.query(
          `
          INSERT INTO public.imap_thread_work_queue (
            run_id, message_id, account_id, reason, attempts, available_at, last_error
          )
          SELECT $1, message.id, message.account_id, 'threading_retry', 1,
                 now() + interval '5 seconds', $4
          FROM public.imap_messages message
          WHERE message.account_id = $2 AND message.id = ANY($3::uuid[])
          ON CONFLICT (run_id, message_id) DO UPDATE SET
            reason = 'threading_retry',
            attempts = public.imap_thread_work_queue.attempts + 1,
            available_at = CASE WHEN $5::integer IS NOT NULL
              THEN now() + interval '5 seconds'
              ELSE now() + make_interval(
                secs => least(3600, (5 * power(2, least(public.imap_thread_work_queue.attempts, 10)))::integer)
              )
            END,
            last_error = EXCLUDED.last_error
          `,
          [run.id, run.account_id, messageIds, reason, adaptiveBatchSize]
        );
      }
      await this.insertOperation(client, {
        run,
        type: "failure",
        requestedBy,
        reason: "threading processing failed",
        status: "failed",
        summary: {
          error: reason,
          messages_attempted: messageIds.length,
          adaptive_retry_batch_size: adaptiveBatchSize
        }
      });
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  }

  private async withAccountLock<T>(accountId: string, fn: (client: PgClient) => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();
    const name = `supamail.threading:${accountId}`;
    try {
      const acquired = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [name]
      );
      if (!acquired.rows[0]?.locked) return null;
      try {
        return await fn(client);
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [name]).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  private emptyResult(accountId: string): ThreadingRunResult {
    return {
      accountId,
      runId: null,
      runStatus: null,
      stage: null,
      operationId: null,
      operationType: null,
      generation: null,
      messagesConsidered: 0,
      assignmentsChanged: 0,
      queueItemsProcessed: 0,
      subjectFallbackEnabled: false,
      busy: false,
      ready: false,
      active: false
    };
  }

  private resultForRun(
    accountId: string,
    run: ThreadRun,
    overrides: Partial<ThreadingRunResult> = {}
  ): ThreadingRunResult {
    return {
      ...this.emptyResult(accountId),
      runId: run.id,
      runStatus: run.status,
      stage: run.stage,
      ready: run.status === "ready" || run.status === "active" || run.status === "standby",
      active: run.status === "active",
      ...overrides
    };
  }
}

interface HistoryEntry {
  message_id: string;
  change_type: "insert" | "update" | "delete";
  previous_assignment: Record<string, unknown> | null;
  next_assignment: Record<string, unknown> | null;
}
