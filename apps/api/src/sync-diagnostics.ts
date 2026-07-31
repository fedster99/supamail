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
  /does not exist/i,
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
