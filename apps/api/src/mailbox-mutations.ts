import { ImapFlow } from "imapflow";
import type { AppConfig } from "./config.js";
import { decryptPassword } from "./crypto.js";
import type { PgClient, PgPool } from "./db.js";
import { assertSafeImapTarget } from "./host-validation.js";
import { getProviderProfile, type ProviderProfile } from "./provider-profiles.js";
import { MirrorRepository } from "./repository.js";
import type { ImapAccount, ImapMessage } from "./types.js";

/**
 * Mechanical IMAP write verbs — mark read/unread, star/unstar, move, trash,
 * delete, and folder CRUD (email-002, ADR 0018). This module lives OUTSIDE
 * src/mcp/ on purpose: the agent surface is read-only/zero-mutate by construction
 * (ADR 0014), so these write verbs must never be importable from there. The sync
 * read adapter (imap-client.ts) likewise never gains a write verb — STORE / MOVE
 * / EXPUNGE / mailboxCreate live ONLY on {@link MailboxMutator} here.
 *
 * Messages are addressed by their mirror id (imap_messages.id). We resolve the
 * folder path + UIDVALIDITY + UID from the repository and act on IMAP BY UID,
 * after asserting the live mailbox UIDVALIDITY still matches what we mirrored (so
 * a UIDVALIDITY reset can never make us hit the wrong message). We do NOT guess a
 * mirror write — the next sync pass reconciles flags (flag scan) and moves/deletes
 * (UID reconcile); see ADR 0018.
 */

/** A SupaMail well-known flag name mapped to its IMAP system flag. */
export const SYSTEM_FLAGS = {
  seen: "\\Seen",
  flagged: "\\Flagged",
  answered: "\\Answered",
  draft: "\\Draft",
  deleted: "\\Deleted"
} as const;

export type SystemFlagName = keyof typeof SYSTEM_FLAGS;

/** The resolved IMAP coordinates of one mirrored message. */
export interface ResolvedMessageTarget {
  messageId: string;
  accountId: string;
  folderPath: string;
  uidValidity: number;
  uid: number;
}

function toTarget(message: ImapMessage): ResolvedMessageTarget {
  return {
    messageId: message.id,
    accountId: message.account_id,
    folderPath: message.folder_path,
    uidValidity: Number(message.uidvalidity),
    uid: Number(message.uid)
  };
}

/** Normalize a caller-supplied flag token to its IMAP system-flag spelling.
 * Accepts the SupaMail short name (`seen`), the bare keyword (`Seen`), or the
 * already-prefixed system flag (`\Seen`). Unknown tokens pass through verbatim so
 * custom IMAP keywords still work. */
export function toImapFlag(token: string): string {
  const trimmed = token.trim();
  const bare = trimmed.replace(/^\\+/, "").toLowerCase();
  if (bare in SYSTEM_FLAGS) return SYSTEM_FLAGS[bare as SystemFlagName];
  return trimmed.startsWith("\\") ? trimmed : `\\${trimmed.replace(/^\\+/, "")}`;
}

/**
 * Resolve the Trash folder to move into: the `\Trash` special-use mailbox if the
 * server advertises one, else the conventional `"Trash"`. Mirrors
 * resolveSentFolder (smtp-client.ts).
 */
export function resolveTrashFolder(
  mailboxes: Array<{ path: string; specialUse?: string | null }>,
  _profile: ProviderProfile
): string {
  const bySpecialUse = mailboxes.find((m) => (m.specialUse ?? "").toLowerCase() === "\\trash");
  if (bySpecialUse) return bySpecialUse.path;
  const byName = mailboxes.find((m) => m.path.toLowerCase().split(/[/.]/).pop() === "trash");
  if (byName) return byName.path;
  return "Trash";
}

/**
 * Write-only IMAP client for organize mutations. Reuses the exact connect +
 * decrypt + assertSafeImapTarget pattern from imap-client.ts / smtp-client.ts but
 * exposes ONLY mutation verbs (STORE flags, MOVE, DELETE+EXPUNGE, mailbox CRUD)
 * and `list()` (so callers can resolve Trash by special-use). It never reads
 * message content and is never used by the sync engine.
 *
 * Every per-message verb is UID-addressed and runs under a per-folder mailbox
 * lock with a UIDVALIDITY guard, so a verb can only ever touch the exact message
 * the caller resolved.
 */
export class MailboxMutator {
  private constructor(
    private readonly client: ImapFlow,
    private readonly commandTimeoutMs: number
  ) {}

  static async connect(
    pool: PgPool,
    config: AppConfig,
    account: ImapAccount
  ): Promise<MailboxMutator> {
    await assertSafeImapTarget(account.host, account.port, account.secure, {
      allowPrivateHosts: config.IMAP_ALLOW_PRIVATE_HOSTS
    });
    const password = await decryptPassword(pool, account.encrypted_password, config.IMAP_ENCRYPTION_KEY);
    const client = new ImapFlow({
      host: account.host,
      port: account.port,
      secure: account.secure,
      auth: { user: account.username, pass: password },
      logger: false,
      connectionTimeout: config.CONNECT_TIMEOUT_MS,
      greetingTimeout: config.CONNECT_TIMEOUT_MS,
      socketTimeout: config.IMAP_COMMAND_TIMEOUT_MS
    });
    await client.connect();
    return new MailboxMutator(client, config.IMAP_COMMAND_TIMEOUT_MS);
  }

  /** List mailboxes so callers can resolve Trash (or validate a move target). */
  async list(): Promise<Array<{ path: string; specialUse?: string | null }>> {
    const boxes = await this.client.list();
    return boxes.map((b) => ({ path: b.path, specialUse: b.specialUse ?? null }));
  }

  /**
   * Select `target.folderPath`, assert the live UIDVALIDITY still equals what we
   * mirrored (a reset would invalidate the UID), then run `op` by UID under the
   * folder lock. Returns whatever `op` returns. Throwing on a UIDVALIDITY mismatch
   * is deliberate: we refuse to act on a possibly-wrong message and let the next
   * sync re-establish identity.
   */
  private async withUidScope<T>(target: ResolvedMessageTarget, op: () => Promise<T>): Promise<T> {
    const lock = await this.client.getMailboxLock(target.folderPath);
    try {
      const mailbox = this.client.mailbox;
      if (mailbox && Number(mailbox.uidValidity) !== target.uidValidity) {
        throw new Error(
          `UIDVALIDITY changed for ${target.folderPath} (mirror ${target.uidValidity} != server ${mailbox.uidValidity}); refusing to mutate by stale UID`
        );
      }
      return await op();
    } finally {
      lock.release();
    }
  }

  /** STORE +FLAGS on the message's folder by UID. */
  async addFlags(target: ResolvedMessageTarget, flags: string[]): Promise<boolean> {
    return this.withUidScope(target, () =>
      this.client.messageFlagsAdd(String(target.uid), flags, { uid: true })
    );
  }

  /** STORE -FLAGS on the message's folder by UID. */
  async removeFlags(target: ResolvedMessageTarget, flags: string[]): Promise<boolean> {
    return this.withUidScope(target, () =>
      this.client.messageFlagsRemove(String(target.uid), flags, { uid: true })
    );
  }

  /** MOVE the message by UID into `destination`. */
  async move(target: ResolvedMessageTarget, destination: string): Promise<{ uidMap: Map<number, number> | null }> {
    return this.withUidScope(target, async () => {
      const result = await this.client.messageMove(String(target.uid), destination, { uid: true });
      return { uidMap: result && typeof result === "object" ? result.uidMap ?? null : null };
    });
  }

  /**
   * Hard-delete: STORE +\Deleted then EXPUNGE that single UID. EXPUNGE is scoped
   * to the one UID (uidRange) so it can never purge other \Deleted messages a
   * client left behind.
   */
  async expunge(target: ResolvedMessageTarget): Promise<boolean> {
    return this.withUidScope(target, async () => {
      await this.client.messageFlagsAdd(String(target.uid), [SYSTEM_FLAGS.deleted], { uid: true });
      return this.client.messageDelete(String(target.uid), { uid: true });
    });
  }

  async createFolder(path: string): Promise<{ path: string; created: boolean }> {
    const result = await this.client.mailboxCreate(path);
    return { path: result.path, created: result.created };
  }

  async renameFolder(path: string, newPath: string): Promise<{ path: string; newPath: string }> {
    const result = await this.client.mailboxRename(path, newPath);
    return { path: result.path, newPath: result.newPath };
  }

  async deleteFolder(path: string): Promise<{ path: string }> {
    const result = await this.client.mailboxDelete(path);
    return { path: result.path };
  }

  async logout(): Promise<void> {
    await this.client.logout();
  }

  close(): void {
    this.client.close();
  }
}

// ---------------------------------------------------------------------------
// Library functions: resolve from the repository, act on IMAP, rely on sync.
// ---------------------------------------------------------------------------

async function loadMessageAndAccount(
  repository: MirrorRepository,
  messageId: string
): Promise<{ message: ImapMessage; account: ImapAccount }> {
  const message = await repository.getMessage(messageId);
  if (!message) throw new Error(`Message not found: ${messageId}`);
  if (message.deleted_in_provider) {
    throw new Error(`Message ${messageId} is already deleted in the provider`);
  }
  const account = await repository.getAccount(message.account_id);
  if (!account) throw new Error(`Account not found for message ${messageId}: ${message.account_id}`);
  return { message, account };
}

export interface FlagChange {
  /** Flags to STORE +FLAGS (mark read = ["\\Seen"], star = ["\\Flagged"]). */
  add?: string[];
  /** Flags to STORE -FLAGS (mark unread = ["\\Seen"], unstar = ["\\Flagged"]). */
  remove?: string[];
}

export interface FlagResult {
  messageId: string;
  folderPath: string;
  uid: number;
  added: string[];
  removed: string[];
}

/**
 * Apply a flag change to one mirrored message by UID. `add`/`remove` accept the
 * SupaMail short names (`seen`/`flagged`/…), bare keywords, or `\`-prefixed
 * system flags. Relies on the next flag-scan sync pass to reflect the change in
 * the mirror (ADR 0018).
 */
export async function setMessageFlags(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  change: FlagChange
): Promise<FlagResult> {
  const add = (change.add ?? []).map(toImapFlag);
  const remove = (change.remove ?? []).map(toImapFlag);
  if (add.length === 0 && remove.length === 0) {
    throw new Error("setMessageFlags requires at least one flag to add or remove");
  }

  const repository = new MirrorRepository(pool, config);
  const { message, account } = await loadMessageAndAccount(repository, messageId);
  const target = toTarget(message);

  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    if (add.length > 0) await mutator.addFlags(target, add);
    if (remove.length > 0) await mutator.removeFlags(target, remove);
  } finally {
    await mutator.logout().catch(() => mutator.close());
  }

  return { messageId, folderPath: target.folderPath, uid: target.uid, added: add, removed: remove };
}

export interface MoveResult {
  messageId: string;
  fromFolder: string;
  toFolder: string;
  /** Destination UID from UIDPLUS COPYUID when the server provides it, else null. */
  newUid: number | null;
}

/** Move one mirrored message to `destination` by UID. The next reconcile sync
 * marks the source row deleted and the destination copy is mirrored. */
export async function moveMessage(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  destination: string
): Promise<MoveResult> {
  if (!destination || destination.trim().length === 0) {
    throw new Error("moveMessage requires a non-empty destination folder");
  }
  const repository = new MirrorRepository(pool, config);
  const { message, account } = await loadMessageAndAccount(repository, messageId);
  const target = toTarget(message);

  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    const { uidMap } = await mutator.move(target, destination);
    const newUid = uidMap?.get(target.uid) ?? null;
    return { messageId, fromFolder: target.folderPath, toFolder: destination, newUid };
  } finally {
    await mutator.logout().catch(() => mutator.close());
  }
}

export interface DeleteResult {
  messageId: string;
  fromFolder: string;
  /** "trash" = moved to Trash; "expunge" = hard-deleted (EXPUNGE). */
  mode: "trash" | "expunge";
  /** The Trash folder moved into (trash mode only). */
  trashFolder: string | null;
}

/**
 * Delete one mirrored message. Default ("trash") moves it to the resolved Trash
 * folder (reversible, the safe default). `hard: true` STOREs `\Deleted` and
 * EXPUNGEs the single UID (irreversible). Either way the next sync reconciles the
 * source row as deleted-in-provider.
 */
export async function deleteMessage(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  options: { hard?: boolean } = {}
): Promise<DeleteResult> {
  const repository = new MirrorRepository(pool, config);
  const { message, account } = await loadMessageAndAccount(repository, messageId);
  const target = toTarget(message);

  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    if (options.hard) {
      await mutator.expunge(target);
      return { messageId, fromFolder: target.folderPath, mode: "expunge", trashFolder: null };
    }
    const profile = getProviderProfile(account.provider_profile);
    const mailboxes = await mutator.list();
    const trashFolder = resolveTrashFolder(mailboxes, profile);
    // Already in Trash → a non-hard delete is a no-op move onto itself; treat as done.
    if (trashFolder === target.folderPath) {
      return { messageId, fromFolder: target.folderPath, mode: "trash", trashFolder };
    }
    await mutator.move(target, trashFolder);
    return { messageId, fromFolder: target.folderPath, mode: "trash", trashFolder };
  } finally {
    await mutator.logout().catch(() => mutator.close());
  }
}

// ---------------------------------------------------------------------------
// Thread-level fan-out: resolve every live message in the thread, then apply.
// ---------------------------------------------------------------------------

/** A live thread member's IMAP coordinates (id + folder + UIDVALIDITY + UID). */
interface ThreadMemberRow {
  id: string;
  account_id: string;
  folder_path: string;
  uidvalidity: string;
  uid: string;
}

/**
 * Resolve every live (not deleted-in-provider) message in the thread seeded by
 * `messageId`, using the SAME one-hop References walk as read_thread (ADR 0016):
 * the seed's provider_thread_id + its own id + the normalized
 * Message-Id/In-Reply-To token set. Returns targets grouped per message.
 */
async function resolveThreadTargets(
  pool: PgPool,
  messageId: string
): Promise<{ accountId: string; targets: ResolvedMessageTarget[] }> {
  const client: PgClient = await pool.connect();
  try {
    const seedResult = await client.query<{
      id: string;
      provider_thread_id: string | null;
      rfc_message_id: string | null;
      message_id_normalized: string | null;
      in_reply_to: string | null;
      references_header: string | null;
      account_id: string;
    }>(
      `
      SELECT id, provider_thread_id, rfc_message_id, message_id_normalized,
             in_reply_to, references_header, account_id
      FROM public.imap_messages
      WHERE id = $1
        AND deleted_in_provider = false
      `,
      [messageId]
    );
    const seed = seedResult.rows[0];
    if (!seed) throw new Error(`Message not found: ${messageId}`);

    const keys = new Set<string>();
    const pushToken = (token: string): void => {
      const normalized = token.trim().replace(/^<+/, "").replace(/>+$/, "").trim().toLowerCase();
      if (normalized) keys.add(normalized);
    };
    if (seed.references_header) seed.references_header.split(/\s+/).forEach(pushToken);
    if (seed.in_reply_to) seed.in_reply_to.split(/\s+/).forEach(pushToken);
    if (seed.rfc_message_id) pushToken(seed.rfc_message_id);
    if (seed.message_id_normalized) pushToken(seed.message_id_normalized);

    const members = await client.query<ThreadMemberRow>(
      `
      SELECT id, account_id, folder_path, uidvalidity, uid
      FROM public.imap_messages
      WHERE account_id = $1
        AND deleted_in_provider = false
        AND (
          ($2::text IS NOT NULL AND provider_thread_id = $2)
          OR id = $3
          OR message_id_normalized = ANY($4::text[])
          OR lower(trim(both '<>' from in_reply_to)) = ANY($4::text[])
        )
      ORDER BY internal_date ASC, id ASC
      `,
      [seed.account_id, seed.provider_thread_id, seed.id, [...keys]]
    );

    const targets = members.rows.map((row) => ({
      messageId: row.id,
      accountId: row.account_id,
      folderPath: row.folder_path,
      uidValidity: Number(row.uidvalidity),
      uid: Number(row.uid)
    }));
    return { accountId: seed.account_id, targets };
  } finally {
    client.release();
  }
}

export interface ThreadFlagResult {
  seedMessageId: string;
  messageCount: number;
  added: string[];
  removed: string[];
  messageIds: string[];
}

/** Mark/star a whole thread: apply the flag change to every live message in the
 * thread seeded by `messageId`, each addressed by its own folder + UID. */
export async function setThreadFlags(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  change: FlagChange
): Promise<ThreadFlagResult> {
  const add = (change.add ?? []).map(toImapFlag);
  const remove = (change.remove ?? []).map(toImapFlag);
  if (add.length === 0 && remove.length === 0) {
    throw new Error("setThreadFlags requires at least one flag to add or remove");
  }

  const repository = new MirrorRepository(pool, config);
  const { accountId, targets } = await resolveThreadTargets(pool, messageId);
  const account = await repository.getAccount(accountId);
  if (!account) throw new Error(`Account not found for thread ${messageId}: ${accountId}`);

  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    for (const target of targets) {
      if (add.length > 0) await mutator.addFlags(target, add);
      if (remove.length > 0) await mutator.removeFlags(target, remove);
    }
  } finally {
    await mutator.logout().catch(() => mutator.close());
  }

  return {
    seedMessageId: messageId,
    messageCount: targets.length,
    added: add,
    removed: remove,
    messageIds: targets.map((t) => t.messageId)
  };
}

export interface ThreadMoveResult {
  seedMessageId: string;
  toFolder: string;
  messageCount: number;
  messageIds: string[];
}

/** Move a whole thread into `destination`: move every live message in the thread,
 * each by its own folder + UID. Skips members already in the destination. */
export async function moveThread(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  destination: string
): Promise<ThreadMoveResult> {
  if (!destination || destination.trim().length === 0) {
    throw new Error("moveThread requires a non-empty destination folder");
  }
  const repository = new MirrorRepository(pool, config);
  const { accountId, targets } = await resolveThreadTargets(pool, messageId);
  const account = await repository.getAccount(accountId);
  if (!account) throw new Error(`Account not found for thread ${messageId}: ${accountId}`);

  const moved: string[] = [];
  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    for (const target of targets) {
      if (target.folderPath === destination) continue;
      await mutator.move(target, destination);
      moved.push(target.messageId);
    }
  } finally {
    await mutator.logout().catch(() => mutator.close());
  }

  return { seedMessageId: messageId, toFolder: destination, messageCount: moved.length, messageIds: moved };
}

// ---------------------------------------------------------------------------
// Folder CRUD: account-scoped create / rename / delete mailbox.
// ---------------------------------------------------------------------------

export interface FolderMutationResult {
  accountId: string;
  path: string;
  newPath?: string;
  created?: boolean;
}

export async function createFolder(
  pool: PgPool,
  config: AppConfig,
  accountId: string,
  path: string
): Promise<FolderMutationResult> {
  if (!path || path.trim().length === 0) throw new Error("createFolder requires a non-empty path");
  const repository = new MirrorRepository(pool, config);
  const account = await repository.getAccount(accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    const result = await mutator.createFolder(path);
    return { accountId, path: result.path, created: result.created };
  } finally {
    await mutator.logout().catch(() => mutator.close());
  }
}

export async function renameFolder(
  pool: PgPool,
  config: AppConfig,
  accountId: string,
  path: string,
  newPath: string
): Promise<FolderMutationResult> {
  if (!path || !newPath) throw new Error("renameFolder requires both path and newPath");
  const repository = new MirrorRepository(pool, config);
  const account = await repository.getAccount(accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    const result = await mutator.renameFolder(path, newPath);
    return { accountId, path: result.path, newPath: result.newPath };
  } finally {
    await mutator.logout().catch(() => mutator.close());
  }
}

export async function deleteFolder(
  pool: PgPool,
  config: AppConfig,
  accountId: string,
  path: string
): Promise<FolderMutationResult> {
  if (!path || path.trim().length === 0) throw new Error("deleteFolder requires a non-empty path");
  const repository = new MirrorRepository(pool, config);
  const account = await repository.getAccount(accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    const result = await mutator.deleteFolder(path);
    return { accountId, path: result.path };
  } finally {
    await mutator.logout().catch(() => mutator.close());
  }
}
