const ERROR_REASON_MAX_LEN = 1_000;
const CREDENTIAL_LEAK_PATTERN = /\b(LOGIN|AUTHENTICATE|PLAIN|XOAUTH2?)\b[\s\S]*$/i;

const AUTH_ERROR_PATTERNS = [
  /AUTH_ERROR/i,
  /authentication failed/i,
  /invalid credentials/i,
  /invalid (user|username|login)/i,
  /incorrect password/i,
  /login failed/i,
  /auth(?:enticate)? failed/i,
  /AUTHENTICATIONFAILED/i,
  /\[AUTH\]/i,
  /\bELOGIN\b/i,
  /\bNO LOGIN\b/i,
  /\b535\b/,
];

const MISSING_MAILBOX_PATTERNS = [
  /\bNONEXISTENT\b/i,
  /\bTRYCREATE\b/i,
  /mailbox.*missing/i,
  /does(?: not|n't) exist/i,
  /no such mailbox/i,
  /mailbox not found/i,
];

export function sanitizeErrorReason(error: string): string {
  return error
    .replace(CREDENTIAL_LEAK_PATTERN, "$1 [REDACTED]")
    .replace(/[\x00-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ERROR_REASON_MAX_LEN);
}

export function isAuthDiagnosticText(error: string): boolean {
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

export function isMissingMailboxDiagnosticText(error: string): boolean {
  return MISSING_MAILBOX_PATTERNS.some((pattern) => pattern.test(error));
}

/** Return a fixed operational code. Never return provider text. */
export function diagnosticErrorCode(error: string): string {
  // Classify authentication before credential redaction. Redaction intentionally
  // removes text after LOGIN/AUTHENTICATE and can otherwise hide the signal.
  if (isAuthDiagnosticText(error)) return "AUTH_ERROR";
  const normalized = sanitizeErrorReason(error);
  if (/RATE.?LIMIT|THROTTL|TOO MANY REQUESTS/i.test(normalized)) return "RATE_LIMITED";
  if (/TIMEOUT|TIMED OUT|DEADLINE EXCEEDED/i.test(normalized)) return "SYNC_TIMEOUT";
  if (/CERTIFICATE|\bTLS\b|\bSSL\b/i.test(normalized)) return "TLS_ERROR";
  if (isMissingMailboxDiagnosticText(normalized)) return "MAILBOX_MISSING";
  if (/ECONN|ENOTFOUND|EAI_AGAIN|CONNECTION|DISCONNECT/i.test(normalized)) {
    return "CONNECTION_ERROR";
  }
  return "SYNC_ERROR";
}

// Diagnostic detail is independent of the legacy health/backoff classification.
// Never persist arbitrary error properties, messages, response text or causes.
export const SYNC_FAILURE_STAGES = [
  "account_lock", "account_start", "connect", "folder_discovery", "folder_status",
  "folder_selection", "folder_sync", "body_backlog", "history", "account_finish",
  "run_finish"
] as const;
export type SyncFailureStage = typeof SYNC_FAILURE_STAGES[number];

const ERROR_CODES = new Map([
  ...["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].map(code => [code, code] as const),
  ["NoConnection", "CONNECTION_CLOSED"], ["EConnectionClosed", "CONNECTION_CLOSED"],
  ["ConnectionClosed", "CONNECTION_CLOSED"], ["ETIMEOUT", "ETIMEDOUT"],
  ["40001", "DB_SERIALIZATION_FAILURE"], ["40P01", "DB_DEADLOCK"],
  ["55P03", "DB_LOCK_UNAVAILABLE"], ["57014", "DB_QUERY_CANCELED"],
  ["23505", "DB_UNIQUE_VIOLATION"], ["23503", "DB_FOREIGN_KEY_VIOLATION"],
  ["42501", "DB_PERMISSION_DENIED"], ["53300", "DB_CONNECTION_LIMIT"],
  ["57P01", "DB_SHUTDOWN"], ["08006", "DB_CONNECTION_FAILURE"]
]);
const RESPONSE_CODES = new Set([
  "NONEXISTENT", "TRYCREATE", "UNAVAILABLE", "SERVERBUG", "CLIENTBUG",
  "AUTHENTICATIONFAILED", "AUTHORIZATIONFAILED", "LIMIT", "OVERQUOTA", "INUSE"
]);
const ERROR_NAMES = new Map([
  ["AccountLockLivenessError", "ACCOUNT_LOCK_LIVENESS_FAILED"],
  ["AccountAlreadyFinalizedError", "ACCOUNT_ALREADY_FINALIZED"],
  ["IncompleteUidListError", "INCOMPLETE_UID_LIST"],
  ["HostValidationError", "HOST_VALIDATION_FAILED"],
  ["SyncInterruptedError", "SYNC_INTERRUPTED"], ["AbortError", "ABORTED"]
]);
const FAILURE_CODES = new Set([
  ...ERROR_CODES.values(), ...ERROR_NAMES.values(),
  ...[...RESPONSE_CODES].map(code => `IMAP_${code}`),
  "LOGIN_REFUSED", "IMAP_NO", "IMAP_BAD", "FOLDER_SET_CHANGED", "SYNC_ERROR"
]);
export interface SyncFailure {
  stage: SyncFailureStage;
  code: string;
}
const MAX_SYNC_FAILURES = 32;

export function syncFailureCode(error: unknown): string {
  if (!error || typeof error !== "object") return "SYNC_ERROR";
  const detail = error as Record<string, unknown>;
  if (typeof detail.code === "string" && ERROR_CODES.has(detail.code)) return ERROR_CODES.get(detail.code)!;
  for (const field of ["serverResponseCode", "responseCode"]) {
    const code = detail[field];
    if (typeof code === "string" && RESPONSE_CODES.has(code)) return `IMAP_${code}`;
  }
  // ImapFlow marks transient LOGIN failures as authenticationFailed too.
  // A socket or explicit server response above is more precise than that flag.
  if (detail.authenticationFailed === true || detail.code === "ELOGIN") return "LOGIN_REFUSED";
  if (typeof detail.name === "string" && ERROR_NAMES.has(detail.name)) return ERROR_NAMES.get(detail.name)!;
  if (detail.responseStatus === "NO" || detail.responseStatus === "BAD") return `IMAP_${detail.responseStatus}`;
  return "SYNC_ERROR";
}

export function recordSyncFailure(failures: SyncFailure[], stage: SyncFailureStage, error: unknown): void {
  const code = syncFailureCode(error);
  if (failures.length < MAX_SYNC_FAILURES && !failures.some(f => f.stage === stage && f.code === code)) {
    failures.push({ stage, code });
  }
}

/** Validate again at the durable boundary, including callers outside the engine. */
export function safeSyncFailures(input: unknown): SyncFailure[] {
  if (!Array.isArray(input)) return [];
  const failures: SyncFailure[] = [];
  for (const value of input) {
    if (!value || typeof value !== "object") continue;
    const { stage, code } = value;
    if (!SYNC_FAILURE_STAGES.includes(stage) || !FAILURE_CODES.has(code)) continue;
    if (!failures.some(f => f.stage === stage && f.code === code)) failures.push({ stage, code });
    if (failures.length === MAX_SYNC_FAILURES) break;
  }
  return failures;
}
