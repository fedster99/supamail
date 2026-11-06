/**
 * Every named step of a direct action (ADR 0054). Each step is time the action
 * spends on one resource, so a host that records them sees where a slow action
 * went. A step may repeat; its durations add up.
 * - `db_load`: the rows an action reads first (account, message, draft, attachment
 *   metadata) and the stored source of a draft being sent.
 * - `compose`: building the message bytes.
 * - `db_lock`: waiting for, taking and releasing the account lock.
 * - `imap_*`: one IMAP command or login each. `imap_connect` covers the host check,
 *   password decryption, TLS and login; `imap_reuse` checks a parked session
 *   instead (ADR 0051); `imap_logout` ends or parks the session.
 * - `smtp_send`: the SMTP credentials, the target check and the submission.
 * - `db_mirror`: mirror writes: a filed message's row and body (parsed and stored
 *   in the host's body store), write-through of flags and moves, and folders
 *   marked due for reconcile.
 */
export const ACTION_STEPS = [
  "db_load", "compose", "db_lock",
  "imap_connect", "imap_reuse", "imap_list", "imap_find", "imap_fetch", "imap_append",
  "imap_store", "imap_move", "imap_expunge", "imap_folder", "imap_logout",
  "smtp_send", "db_mirror"
] as const;
export type ActionStep = (typeof ACTION_STEPS)[number];
export type ActionStepTimer = (step: ActionStep, ms: number) => void;

export function reportStep(onStep: ActionStepTimer | undefined, step: ActionStep, startedAt: number): void {
  try { onStep?.(step, performance.now() - startedAt); } catch { /* timing never changes an action */ }
}

/** Run one step and report its duration, also when it fails; a timer that throws
 * never changes the step. */
export async function timeStep<T>(onStep: ActionStepTimer | undefined, step: ActionStep, work: () => Promise<T>): Promise<T> {
  if (!onStep) return await work();
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    reportStep(onStep, step, startedAt);
  }
}
