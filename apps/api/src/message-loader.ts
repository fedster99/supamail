import { NotFoundError } from "./errors.js";
import type { MirrorRepository } from "./repository.js";
import type { ImapAccount, ImapMessage } from "./types.js";

/**
 * Resolve a mirrored message + its owning account by mirror message id — the one
 * shared "load by id" the content (fetch), mutation, and draft-update paths each
 * inlined near-byte-identically (review maintainability finding). It throws
 * {@link NotFoundError} (→ HTTP 404) when the message row is absent and a plain
 * `Error` when the account row is missing (an invariant violation, not a client
 * error). With `requireLive: true` it ALSO refuses a message already marked
 * deleted-in-provider (a plain `Error`) — the guard the mutation path needs so a
 * write verb never acts on a tombstoned row; the read (content) path passes no
 * option, so a deleted-in-provider message stays fetchable. Behavior is
 * byte-identical to the three previous inlined copies; the `requireLive` flag is
 * the ONLY thing that ever differed between them.
 *
 * This lives in its own tiny module (not in repository.ts) so the lib tests that
 * `vi.mock("../repository.js")` keep mocking ONLY the repository class while this
 * pure loader runs unchanged against the mocked instance — the dedup adds no test
 * plumbing.
 */
export async function loadMessageAndAccount(
  repository: MirrorRepository,
  messageId: string,
  options: { requireLive?: boolean } = {}
): Promise<{ message: ImapMessage; account: ImapAccount }> {
  const message = await repository.getMessage(messageId);
  if (!message) throw new NotFoundError(`Message not found: ${messageId}`);
  if (options.requireLive && message.deleted_in_provider) {
    throw new Error(`Message ${messageId} is already deleted in the provider`);
  }
  const account = await repository.getAccount(message.account_id);
  if (!account) throw new Error(`Account not found for message ${messageId}: ${message.account_id}`);
  return { message, account };
}
