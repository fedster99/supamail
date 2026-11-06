import type { PgPool } from "./db.js";
import { AccountBusyError } from "./errors.js";
import { reportStep, timeStep, type ActionStepTimer } from "./action-steps.js";
import { withAccountLock, type AccountLock, type AccountLockOptions } from "./locks.js";

/** How long a direct mailbox write waits for a sync holding the account lock. */
export const INTERACTIVE_LOCK_WAIT_MS = 25_000;

/**
 * Run one direct mailbox write (draft, send, flag, move, delete, folder change)
 * under the account lock: one mirror-changing operation per Mailbox Account at a
 * time (read-only body downloads run beside it, ADR 0049), and no sync interleaves
 * with the write. Waits up to {@link INTERACTIVE_LOCK_WAIT_MS} for
 * the current holder. Still held after that is the typed, retryable
 * {@link AccountBusyError}, raised before any provider command.
 */
export async function withInteractiveAccountLock<T>(
  pool: PgPool,
  account: { id: string; lock_id: string | number },
  fn: (lock: AccountLock) => Promise<T>,
  { onStep, ...options }: Omit<AccountLockOptions, "waitMs"> & { onStep?: ActionStepTimer } = {}
): Promise<T> {
  // `db_lock` covers the wait, the acquisition and the release; the callback's own
  // steps report themselves (ADR 0054).
  let lockStepStartedAt = performance.now();
  let result: T | null;
  try {
    result = await withAccountLock(pool, account.lock_id, async (lock) => {
      reportStep(onStep, "db_lock", lockStepStartedAt);
      // A liveness check inside the callback is lock time too.
      const timedLock: AccountLock = {
        ...lock,
        assertLive: () => timeStep(onStep, "db_lock", () => lock.assertLive())
      };
      try {
        return await fn(timedLock);
      } finally {
        lockStepStartedAt = performance.now();
      }
    }, { ...options, waitMs: INTERACTIVE_LOCK_WAIT_MS });
  } finally {
    reportStep(onStep, "db_lock", lockStepStartedAt);
  }
  if (result === null) {
    throw new AccountBusyError(`Account ${account.id} is busy syncing; retry shortly`);
  }
  return result;
}
