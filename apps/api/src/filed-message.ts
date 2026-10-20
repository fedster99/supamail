import { DatabaseBodyStore, type BodyStore } from "./body-store.js";
import type { AppConfig } from "./config.js";
import { fetchMessageMetadata, filedMessageBody, ThrottledImapClient } from "./imap-client.js";
import { uidValidityMatches, type ActionConnection, type ActionSocket } from "./imap-connect.js";
import { getProviderProfile, resolveSpecialUseFolder } from "./provider-profiles.js";
import type { MirrorRepository } from "./repository.js";
import { SentFolderAppender, type AppendedUid } from "./smtp-client.js";
import type { ImapAccount } from "./types.js";

/** Bound on the row write; the provider already holds the message. The body store
 * keeps its own request bounds, as it does for sync. */
const FILED_ROW_WRITE_TIMEOUT_MS = 5_000;

/** Where an action stores the bodies it files: the host's store, else the OSS
 * database store that sync also defaults to. */
export function actionBodyStore(repository: MirrorRepository, bodyStore?: BodyStore): BodyStore {
  return bodyStore ?? new DatabaseBodyStore(repository);
}

/** A message this action just filed with APPEND, and the server's APPENDUID for it. */
export interface FiledMessage {
  folderPath: string;
  appended: AppendedUid;
  raw: Buffer;
}

/**
 * Mirror a message this action just filed, as sync would (ADR 0045). The server's
 * APPENDUID names it, so nothing is guessed: read that one UID's metadata on the
 * action's own connection, write the row through sync's upsert, then store the
 * body from the filed bytes when the server holds exactly that many bytes.
 *
 * Only a tracked folder that sync already read at the APPENDUID's UIDVALIDITY
 * qualifies; otherwise this returns null and the next sync mirrors the message.
 * The caller holds the account lock with fenced writes, so no sync interleaves.
 * A failed read or row write throws; a failed body store only warns, because the
 * row and its id stand and the body lane stores the body later. Either way the
 * provider already holds the message, so callers never fail the action.
 */
export async function mirrorFiledMessage(
  repository: MirrorRepository,
  config: AppConfig,
  bodyStore: BodyStore,
  socket: ActionSocket,
  accountId: string,
  filed: FiledMessage,
  warn: (warning: string) => void
): Promise<string | null> {
  const { uid, uidValidity } = filed.appended;
  const [folder] = await repository.getFoldersForWake(accountId, [filed.folderPath]);
  if (!folder || folder.uidvalidity === null || Number(folder.uidvalidity) !== uidValidity) return null;

  // The socket stays the action's: this view only adds sync's command timeout.
  const client = new ThrottledImapClient(socket.client, config.IMAP_MAX_COMMANDS_PER_MINUTE, config.IMAP_COMMAND_TIMEOUT_MS);
  // The folder may still be selected from before the APPEND (a draft's idempotency
  // search); SELECT it again so the new UID is known before the FETCH.
  client.invalidateSelection();
  const metadata = await socket.abort.run(async () => {
    const lock = await client.getMailboxLock(filed.folderPath);
    try {
      if (!uidValidityMatches(client.mailbox, uidValidity)) return null;
      return (await fetchMessageMetadata(client, [uid], 1))[0];
    } finally {
      lock.release();
    }
  });
  if (!metadata) return null;

  const deadlineAt = Date.now() + FILED_ROW_WRITE_TIMEOUT_MS;
  const [row] = await repository.upsertMessages(accountId, folder, uidValidity, [metadata], { deadlineAt });
  if (!row.body_fetched_at && metadata.sizeBytes === filed.raw.length && filed.raw.length < config.BODY_RAW_MAX_BYTES) {
    try {
      const body = await filedMessageBody(config, row, filed.raw, metadata.mimeStructure);
      await repository.storeBodyEvidence(body);
      await bodyStore.store(body);
      await repository.completeBodyStorage(row.id);
    } catch (error) {
      warn(`Mirrored, but the body is readable only after the next sync: ${errorText(error)}.`);
    }
  }
  return row.id;
}

/** The delivered message's copy in Sent, as {@link fileSentCopy} filed it. */
export interface SentCopy {
  appendedToSent: boolean;
  appendedUid: number | null;
  sentFolderPath: string | null;
  /** The copy's mirror id, readable at once; null until the next sync mirrors it. */
  messageId: string | null;
}

/**
 * File the delivered bytes to Sent with `\Seen` and mirror the copy at once
 * (ADR 0045). Delivery already happened, so every failure here is a warning: a
 * thrown error could invite a duplicate send.
 */
export async function fileSentCopy(
  repository: MirrorRepository,
  config: AppConfig,
  bodyStore: BodyStore,
  account: ImapAccount,
  connection: ActionConnection,
  raw: Buffer,
  warn: (warning: string) => void
): Promise<SentCopy> {
  const copy: SentCopy = { appendedToSent: false, appendedUid: null, sentFolderPath: null, messageId: null };
  let appended: AppendedUid | null;
  let socket: ActionSocket;
  try {
    socket = await connection.get();
    const appender = SentFolderAppender.over(socket);
    copy.sentFolderPath = resolveSpecialUseFolder(await appender.list(), "sent", getProviderProfile(account.provider_profile));
    appended = await appender.append(copy.sentFolderPath, raw, ["\\Seen"], new Date());
    copy.appendedToSent = true;
    copy.appendedUid = appended?.uid ?? null;
  } catch (error) {
    warn(`Delivered, but filing to Sent failed: ${errorText(error)}. The next sync will mirror the copy if the provider auto-filed it.`);
    return copy;
  }
  if (!appended) return copy;
  try {
    copy.messageId = await mirrorFiledMessage(repository, config, bodyStore, socket, account.id,
      { folderPath: copy.sentFolderPath, appended, raw }, warn);
  } catch (error) {
    warn(`Delivered, but the sent copy is readable only after the next sync: ${errorText(error)}.`);
  }
  return copy;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
