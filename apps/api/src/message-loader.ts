import { NotFoundError } from "./errors.js";
import type { MirrorRepository } from "./repository.js";
import type { ImapAccount, ImapMessage } from "./types.js";

/**
 * Resolve a live mirrored message and its owning account by mirror message id: the
 * one "load by id" for every content fetch and mutation. A row the provider no
 * longer holds at its mirrored location (deleted, or moved without COPYUID, ADR
 * 0037) is not found here: its UID would address nothing, or something else. It
 * throws {@link NotFoundError} (→ HTTP 404) for an absent or removed row and a
 * plain `Error` when the account row is missing (an invariant violation).
 *
 * This lives in its own tiny module (not in repository.ts) so the lib tests that
 * `vi.mock("../repository.js")` keep mocking ONLY the repository class while this
 * pure loader runs unchanged against the mocked instance.
 */
export async function loadMessageAndAccount(
  repository: MirrorRepository,
  messageId: string
): Promise<{ message: ImapMessage; account: ImapAccount }> {
  const message = await repository.getMessage(messageId);
  if (!message) throw new NotFoundError(`Message not found: ${messageId}`);
  if (message.deleted_in_provider) {
    throw new NotFoundError(`Message ${messageId} was moved or deleted in the mailbox`);
  }
  const account = await repository.getAccount(message.account_id);
  if (!account) throw new Error(`Account not found for message ${messageId}: ${message.account_id}`);
  return { message, account };
}
