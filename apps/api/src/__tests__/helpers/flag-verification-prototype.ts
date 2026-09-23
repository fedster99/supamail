// Experiment only. Not imported by the product or connected to a scheduler.
// The caller must hold the existing account/mailbox lock, bound I/O with the
// existing deadline, and persist the returned checkpoint after flag writes.
import { fetchMessageFlags, type MirrorImapClient } from "../../imap-client.js";
import { MAX_SYNC_BATCH_SIZE } from "../../sync-limits.js";
import type { MessageFlagSnapshot } from "../../types.js";

export type FlagCheckpoint = {
  accountId: string;
  folderPath: string;
  uidValidity: number;
  throughUid: number;
  afterUid: number;
};

export async function verifyFlagPage(input: {
  checkpoint: FlagCheckpoint;
  currentScope: Pick<FlagCheckpoint, "accountId" | "folderPath" | "uidValidity">;
  batchSize: number;
  client: MirrorImapClient;
  // Keyset page of nondeleted, in-window mirrored UIDs for this exact identity.
  // Return at most limit rows, sorted ascending. Never use a provider-wide SEARCH.
  readPage: (scope: FlagCheckpoint, limit: number) => Promise<number[]>;
  applyFlags: (flags: MessageFlagSnapshot[]) => Promise<void>;
}): Promise<{ checkpoint: FlagCheckpoint; complete: boolean; checked: number }> {
  const { checkpoint, currentScope, batchSize, client } = input;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_SYNC_BATCH_SIZE) {
    throw new Error("invalid flag verification batch size");
  }
  if (currentScope.accountId !== checkpoint.accountId
    || currentScope.folderPath !== checkpoint.folderPath) throw new Error("wrong flag verification scope");
  if (currentScope.uidValidity !== checkpoint.uidValidity) throw new Error("stale UIDVALIDITY");
  if (![checkpoint.afterUid, checkpoint.throughUid].every(Number.isSafeInteger)
    || checkpoint.afterUid < 0 || checkpoint.throughUid < checkpoint.afterUid) {
    throw new Error("invalid flag verification checkpoint");
  }
  const page = await input.readPage({ ...checkpoint }, batchSize + 1);
  if (page.length > batchSize + 1 || page.some((uid, i) =>
    !Number.isSafeInteger(uid) || uid <= (i ? page[i - 1] : checkpoint.afterUid)
    || uid > checkpoint.throughUid)) {
    throw new Error("invalid flag verification page");
  }
  const uids = page.slice(0, batchSize);
  if (uids.length) {
    const flags = await fetchMessageFlags(client, uids, batchSize);
    // A failed FETCH or failed commit cannot advance the checkpoint.
    // A crash after this write but before checkpoint persistence repeats an
    // idempotent flag diff; it must never skip uncommitted flags.
    await input.applyFlags(flags);
  }
  return {
    checkpoint: { ...checkpoint, afterUid: uids.at(-1) ?? checkpoint.afterUid },
    complete: page.length <= batchSize,
    checked: uids.length,
  };
}
