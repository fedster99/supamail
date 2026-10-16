import type { PgPool } from "./db.js";
import { AccountBusyError } from "./errors.js";
import { withAccountLock, type AccountLock, type AccountLockOptions } from "./locks.js";

/** How long a direct mailbox write waits for a sync holding the account lock. */
export const INTERACTIVE_LOCK_WAIT_MS = 25_000;

/**
 * Run one direct mailbox write (draft, send, flag, move, delete, folder change)
 * under the account lock: one IMAP operation per Mailbox Account at a time, and no
 * sync interleaves with the write. Waits up to {@link INTERACTIVE_LOCK_WAIT_MS} for
 * the current holder. Still held after that is the typed, retryable
 * {@link AccountBusyError}, raised before any provider command.
 */
export async function withInteractiveAccountLock<T>(
  pool: PgPool,
  account: { id: string; lock_id: string | number },
  fn: (lock: AccountLock) => Promise<T>,
  options: Omit<AccountLockOptions, "waitMs"> = {}
): Promise<T> {
  const result = await withAccountLock(pool, account.lock_id, fn, {
    ...options,
    waitMs: INTERACTIVE_LOCK_WAIT_MS
  });
  if (result === null) {
    throw new AccountBusyError(`Account ${account.id} is busy syncing; retry shortly`);
  }
  return result;
}
