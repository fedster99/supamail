import type { ImapFlow } from "imapflow";
import type { AppConfig } from "./config.js";
import type { PgClient, PgPool } from "./db.js";
import { NotFoundError } from "./errors.js";
import { closeImap, connectImap, uidValidityMatches, uidValidityMismatchMessage } from "./imap-connect.js";
import { loadMessageAndAccount } from "./message-loader.js";
import { getProviderProfile, resolveSpecialUseFolder } from "./provider-profiles.js";
import { MirrorRepository } from "./repository.js";
import {
  METADATA_PROTECTED_FIELDS,
  plaintextMetadataProtection,
  revealMetadataRecord,
  type MetadataProtectionAdapter,
  type ProtectedMetadataColumns
} from "./metadata-protection.js";
import { threadMembershipClause, threadSeedKeys, type ThreadSeedRow } from "./thread-walk.js";
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
 * a UIDVALIDITY reset can never make us hit the wrong message).
 *
 * Flag mutations (mark read/unread, star/unstar) write the new flag set THROUGH
 * to the mirror row immediately after a successful STORE: that is a deterministic
 * update of a KNOWN row to a KNOWN value (not fabricating identity), and it is
 * required because the flag-scan sync only re-reads flags within
 * FLAG_DIFF_WINDOW_DAYS, so a change to older mail would otherwise never reconcile.
 * Moves and deletes still rely on the next sync's UID reconcile (which can lag by
 * more than the flag window); see ADR 0018.
 *
 * Destructive verbs require server capabilities so a fallback can never run a
 * blanket EXPUNGE: hard delete requires UIDPLUS (UID-scoped EXPUNGE); move
 * requires MOVE or UIDPLUS (native move, or COPY + UID-scoped EXPUNGE). Both
 * absent → the verb refuses rather than risk purging unrelated \Deleted messages.
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

/**
 * Thrown when the live mailbox can no longer be safely addressed by the UID we
 * mirrored — UIDVALIDITY changed, so the stale UID may now point at a different
 * message. Callers (api.ts) map this to HTTP 409 Conflict rather than 500: the
 * request was well-formed, the server state simply moved underneath us.
 */
export class MailboxConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxConflictError";
  }
}

/**
 * Thrown when the IMAP server does not advertise the capability a verb needs to
 * act safely (UIDPLUS for a UID-scoped EXPUNGE, MOVE/UIDPLUS for a non-collateral
 * move). We refuse rather than fall back to a blanket EXPUNGE that would purge
 * unrelated \Deleted messages.
 */
export class MailboxCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxCapabilityError";
  }
}

/**
 * Thrown when an IMAP STORE/MOVE/DELETE returned a server-side failure (imapflow
 * signals these as `false`/empty rather than throwing). We surface it so HTTP/CLI
 * callers and the mirror write-through never proceed on a silent no-op.
 */
export class MailboxMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxMutationError";
  }
}

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
 * Write-only IMAP client for organize mutations. Its socket comes from the one
 * shared {@link connectImap} prelude (decrypt + assertSafeImapTarget + the
 * close-on-connect-error guard, imap-connect.ts); it exposes ONLY mutation verbs
 * (STORE flags, MOVE, DELETE+EXPUNGE, mailbox CRUD) and `list()` (so callers can
 * resolve Trash by special-use). It never reads message content and is never used
 * by the sync engine.
 *
 * Every per-message verb is UID-addressed and runs under a per-folder mailbox
 * lock with a UIDVALIDITY guard, so a verb can only ever touch the exact message
 * the caller resolved.
 */
export class MailboxMutator {
  private constructor(
    private readonly client: ImapFlow,
    private readonly host: string
  ) {}

  static async connect(
    pool: PgPool,
    config: AppConfig,
    account: ImapAccount
  ): Promise<MailboxMutator> {
    // Socket + SSRF guard + decrypt + the close-on-connect-error guard come from the
    // one shared connect prelude (imap-connect.ts); this client only adds the
    // mutation verb surface on top (ADR 0018/0022).
    const client = await connectImap(pool, config, account);
    return new MailboxMutator(client, account.host);
  }

  /** True iff the connected server advertises `name` (e.g. "UIDPLUS", "MOVE").
   * imapflow exposes capabilities as a Map keyed by the uppercase capability name. */
  private hasCapability(name: string): boolean {
    return this.client.capabilities?.has(name) ?? false;
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
      // Shared fail-closed UIDVALIDITY check (imap-connect.ts) — same property as
      // ContentImapClient's fetch guard, but the mutate path keeps its own
      // MailboxConflictError (mapped to HTTP 409 by api.ts).
      if (!uidValidityMatches(mailbox, target.uidValidity)) {
        throw new MailboxConflictError(
          uidValidityMismatchMessage(
            target.folderPath,
            target.uidValidity,
            (mailbox as { uidValidity?: bigint | number }).uidValidity,
            "mutate"
          )
        );
      }
      return await op();
    } finally {
      lock.release();
    }
  }

  /** STORE +FLAGS on the message's folder by UID. imapflow returns `false` on a
   * server-side STORE failure rather than throwing — we surface that as an error. */
  async addFlags(target: ResolvedMessageTarget, flags: string[]): Promise<boolean> {
    return this.withUidScope(target, async () => {
      const ok = await this.client.messageFlagsAdd(String(target.uid), flags, { uid: true });
      if (!ok) {
        throw new MailboxMutationError(
          `STORE +FLAGS failed for UID ${target.uid} in ${target.folderPath} on ${this.host}`
        );
      }
      return ok;
    });
  }

  /** STORE -FLAGS on the message's folder by UID. */
  async removeFlags(target: ResolvedMessageTarget, flags: string[]): Promise<boolean> {
    return this.withUidScope(target, async () => {
      const ok = await this.client.messageFlagsRemove(String(target.uid), flags, { uid: true });
      if (!ok) {
        throw new MailboxMutationError(
          `STORE -FLAGS failed for UID ${target.uid} in ${target.folderPath} on ${this.host}`
        );
      }
      return ok;
    });
  }

  /**
   * MOVE the message by UID into `destination`. Requires either the MOVE extension
   * (a native, atomic, safe move) or UIDPLUS (imapflow falls back to COPY + a
   * UID-scoped EXPUNGE, which is safe). If the server advertises neither, imapflow
   * would fall back to COPY + a blanket EXPUNGE that purges ALL \Deleted messages
   * in the folder — so we refuse instead.
   */
  async move(target: ResolvedMessageTarget, destination: string): Promise<{ uidMap: Map<number, number> | null }> {
    if (!this.hasCapability("MOVE") && !this.hasCapability("UIDPLUS")) {
      throw new MailboxCapabilityError(
        `Move needs the MOVE or UIDPLUS extension to avoid a collateral EXPUNGE; ${this.host} advertises neither`
      );
    }
    return this.withUidScope(target, async () => {
      const result = await this.client.messageMove(String(target.uid), destination, { uid: true });
      if (!result) {
        throw new MailboxMutationError(
          `MOVE failed for UID ${target.uid} from ${target.folderPath} to ${destination} on ${this.host}`
        );
      }
      return { uidMap: typeof result === "object" ? result.uidMap ?? null : null };
    });
  }

  /**
   * Hard-delete: STORE +\Deleted then EXPUNGE that single UID. Requires UIDPLUS:
   * with it, imapflow scopes the EXPUNGE to the one UID (UID EXPUNGE), so it can
   * never purge other \Deleted messages a client left behind. WITHOUT UIDPLUS,
   * imapflow falls back to a blanket EXPUNGE of the whole folder — so we refuse.
   */
  async expunge(target: ResolvedMessageTarget): Promise<boolean> {
    if (!this.hasCapability("UIDPLUS")) {
      throw new MailboxCapabilityError(
        `Hard delete needs the UIDPLUS extension for a UID-scoped EXPUNGE; ${this.host} does not advertise it`
      );
    }
    return this.withUidScope(target, async () => {
      const stored = await this.client.messageFlagsAdd(String(target.uid), [SYSTEM_FLAGS.deleted], { uid: true });
      if (!stored) {
        throw new MailboxMutationError(
          `STORE +\\Deleted failed for UID ${target.uid} in ${target.folderPath} on ${this.host}`
        );
      }
      const ok = await this.client.messageDelete(String(target.uid), { uid: true });
      if (!ok) {
        throw new MailboxMutationError(
          `EXPUNGE failed for UID ${target.uid} in ${target.folderPath} on ${this.host}`
        );
      }
      return ok;
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
 * Write a successful flag change through to the mirror row, best-effort but
 * surfaced: a failure here logs a warning (and never masks the STORE that already
 * succeeded on IMAP). This keeps mark-read/star visible in the mirror immediately,
 * even for mail older than the flag-scan window. Returns true when the mirror row
 * was updated, false on a missing row or a DB error (so thread callers can surface
 * a stale count) — the lag self-heals on the next flag-scan sync.
 */
async function writeFlagsThrough(
  repository: MirrorRepository,
  messageId: string,
  accountId: string,
  add: string[],
  remove: string[]
): Promise<boolean> {
  try {
    const updated = await repository.applyMessageFlags(messageId, accountId, { add, remove });
    if (updated === null) {
      console.warn(JSON.stringify({
        event: "organize.flag_write_through_missing_row",
        messageId,
        accountId
      }));
      return false;
    }
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "organize.flag_write_through_failed",
      messageId,
      accountId,
      error: error instanceof Error ? error.message : String(error)
    }));
    return false;
  }
}

/**
 * Apply a flag change to one mirrored message by UID. `add`/`remove` accept the
 * SupaMail short names (`seen`/`flagged`/…), bare keywords, or `\`-prefixed
 * system flags. After a successful STORE the new flags are written through to the
 * mirror row immediately (ADR 0018) — the flag-scan sync only re-reads recent mail.
 */
export async function setMessageFlags(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  change: FlagChange,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<FlagResult> {
  const add = (change.add ?? []).map(toImapFlag);
  const remove = (change.remove ?? []).map(toImapFlag);
  if (add.length === 0 && remove.length === 0) {
    throw new Error("setMessageFlags requires at least one flag to add or remove");
  }

  const repository = new MirrorRepository(pool, config, metadataProtection);
  const { message, account } = await loadMessageAndAccount(repository, messageId, { requireLive: true });
  const target = toTarget(message);

  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    if (add.length > 0) await mutator.addFlags(target, add);
    if (remove.length > 0) await mutator.removeFlags(target, remove);
  } finally {
    await closeImap(mutator);
  }

  await writeFlagsThrough(repository, target.messageId, target.accountId, add, remove);

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
  destination: string,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<MoveResult> {
  if (!destination || destination.trim().length === 0) {
    throw new Error("moveMessage requires a non-empty destination folder");
  }
  const repository = new MirrorRepository(pool, config, metadataProtection);
  const { message, account } = await loadMessageAndAccount(repository, messageId, { requireLive: true });
  const target = toTarget(message);

  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    const { uidMap } = await mutator.move(target, destination);
    const newUid = uidMap?.get(target.uid) ?? null;
    return { messageId, fromFolder: target.folderPath, toFolder: destination, newUid };
  } finally {
    await closeImap(mutator);
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
  options: { hard?: boolean; metadataProtection?: MetadataProtectionAdapter } = {}
): Promise<DeleteResult> {
  const repository = new MirrorRepository(
    pool,
    config,
    options.metadataProtection ?? plaintextMetadataProtection
  );
  const { message, account } = await loadMessageAndAccount(repository, messageId, { requireLive: true });
  const target = toTarget(message);

  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    if (options.hard) {
      await mutator.expunge(target);
      return { messageId, fromFolder: target.folderPath, mode: "expunge", trashFolder: null };
    }
    const profile = getProviderProfile(account.provider_profile);
    const mailboxes = await mutator.list();
    // Resolve Trash via the shared role-keyed resolver: the "trash" role uses its
    // leaf-name fallback and (unlike Sent) ignores the profile (behavior preserved).
    const trashFolder = resolveSpecialUseFolder(mailboxes, "trash", profile);
    // Already in Trash → a non-hard delete is a no-op move onto itself; treat as done.
    if (trashFolder === target.folderPath) {
      return { messageId, fromFolder: target.folderPath, mode: "trash", trashFolder };
    }
    await mutator.move(target, trashFolder);
    return { messageId, fromFolder: target.folderPath, mode: "trash", trashFolder };
  } finally {
    await closeImap(mutator);
  }
}

// ---------------------------------------------------------------------------
// Thread-level fan-out: resolve every live message in the thread, then apply.
// ---------------------------------------------------------------------------

/**
 * Cap on how many thread members one thread mutation fans out to — the SAME
 * ceiling read_thread uses (mcp/tools/read-thread.ts MAX_MESSAGES_CEILING). A
 * thread mutation does one sequential IMAP round-trip per member under a per-folder
 * lock, so an unbounded fan-out would let a pathological thread hold locks and
 * stack latency linearly. The oldest-first ORDER (thread-walk) makes the cap
 * deterministic: the oldest N members are acted on.
 */
const MAX_THREAD_FANOUT = 100;

/** A live thread member's IMAP coordinates (id + folder + UIDVALIDITY + UID). */
interface ThreadMemberRow {
  id: string;
  account_id: string;
  folder_path: string;
  uidvalidity: string;
  uid: string;
}

type ThreadTargetSeedRow = ThreadSeedRow & ProtectedMetadataColumns & { conversation_id: string | null };

/**
 * Resolve every live (not deleted-in-provider) physical message row in the
 * thread seeded by `messageId`. A stored assignment is authoritative and fans
 * out to the complete account-scoped conversation, including mirrored delivery
 * copies because every physical UID must receive the mutation. Unassigned seeds
 * retain the legacy one-hop References walk as a compatibility fallback.
 */
async function resolveThreadTargets(
  pool: PgPool,
  messageId: string,
  metadataProtection: MetadataProtectionAdapter
): Promise<{ accountId: string; targets: ResolvedMessageTarget[]; truncated: boolean }> {
  const client: PgClient = await pool.connect();
  try {
    // Pin the active-run pointer and both membership reads to one snapshot. An
    // activation may commit concurrently, but one mutation must never resolve its
    // seed under the old projection and its members under the new projection.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const seedResult = await client.query<ThreadTargetSeedRow>(
      `
      SELECT m.id, m.provider_thread_id, m.rfc_message_id, m.message_id_normalized,
             m.in_reply_to, m.references_header, m.account_id,
             m.protected_metadata, m.protected_metadata_version,
             m.protected_metadata_key_version, m.protected_metadata_tokens,
             assignment.conversation_id
      FROM public.imap_messages m
      LEFT JOIN public.imap_thread_active_assignments assignment
        ON assignment.message_id = m.id
       AND assignment.account_id = m.account_id
      WHERE m.id = $1
        AND m.deleted_in_provider = false
      `,
      [messageId]
    );
    const storedSeed = seedResult.rows[0];
    if (!storedSeed) throw new NotFoundError(`Message not found: ${messageId}`);
    const seed = storedSeed.conversation_id ? storedSeed : await revealMetadataRecord(
      metadataProtection,
      { kind: "message", accountId: storedSeed.account_id, recordId: storedSeed.id },
      storedSeed,
      METADATA_PROTECTED_FIELDS.message
    );

    // Fetch MAX_THREAD_FANOUT + 1 so a full result tells us the thread was
    // truncated (the +1 row is dropped). Stored conversations intentionally do
    // NOT collapse delivery_key: mirrored copies are separate physical UIDs and
    // a whole-thread mailbox mutation must reach every one of them.
    let memberRows: ThreadMemberRow[];
    if (seed.conversation_id) {
      const members = await client.query<ThreadMemberRow>(
        `
        SELECT m.id, m.account_id, m.folder_path, m.uidvalidity, m.uid
        FROM public.imap_thread_active_assignments assignment
        JOIN public.imap_messages m
          ON m.id = assignment.message_id
         AND m.account_id = assignment.account_id
        WHERE assignment.account_id = $1
          AND assignment.conversation_id = $2
          AND m.deleted_in_provider = false
        ORDER BY m.internal_date ASC, m.id ASC
        LIMIT $3
        `,
        [seed.account_id, seed.conversation_id, MAX_THREAD_FANOUT + 1]
      );
      memberRows = members.rows;
    } else {
      // Legacy one-hop fallback for messages awaiting an assignment. The shared
      // predicate keeps its strict, case-preserving token set and deterministic ordering in
      // sync with read_thread's compatibility path.
      const keys = threadSeedKeys(seed);
      const members = await client.query<ThreadMemberRow>(
        `
        SELECT id, account_id, folder_path, uidvalidity, uid
        FROM public.imap_messages
        WHERE ${threadMembershipClause("")}
        LIMIT $5
        `,
        [seed.account_id, seed.provider_thread_id, seed.id, keys, MAX_THREAD_FANOUT + 1]
      );
      memberRows = members.rows;
    }

    const truncated = memberRows.length > MAX_THREAD_FANOUT;
    const targets = memberRows.slice(0, MAX_THREAD_FANOUT).map((row) => ({
      messageId: row.id,
      accountId: row.account_id,
      folderPath: row.folder_path,
      uidValidity: Number(row.uidvalidity),
      uid: Number(row.uid)
    }));
    await client.query("COMMIT");
    return { accountId: seed.account_id, targets, truncated };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
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
  /** Members whose mirror write-through lagged (the IMAP STORE succeeded but the
   * mirror row update failed/was missing). 0 = mirror fully in sync. The lag
   * self-heals on the next flag-scan sync. */
  mirrorWriteThroughStale: number;
  /** True when the thread exceeded MAX_THREAD_FANOUT and only the oldest N members
   * were acted on. */
  truncated: boolean;
}

/** Mark/star a whole thread: apply the flag change to every live message in the
 * thread seeded by `messageId`, each addressed by its own folder + UID. */
export async function setThreadFlags(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  change: FlagChange,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<ThreadFlagResult> {
  const add = (change.add ?? []).map(toImapFlag);
  const remove = (change.remove ?? []).map(toImapFlag);
  if (add.length === 0 && remove.length === 0) {
    throw new Error("setThreadFlags requires at least one flag to add or remove");
  }

  const repository = new MirrorRepository(pool, config, metadataProtection);
  const { accountId, targets, truncated } = await resolveThreadTargets(pool, messageId, metadataProtection);
  const account = await repository.getAccount(accountId);
  if (!account) throw new Error(`Account not found for thread ${messageId}: ${accountId}`);

  // Interleave the mirror write-through INTO the per-member loop: each member's
  // mirror row is updated immediately after its own STORE succeeds, so a mid-thread
  // STORE failure (which throws) has already persisted every earlier member's
  // write-through instead of aborting before ANY mirror write (the previous
  // STORE-all-then-write-all shape lost all mirror writes on any failure).
  const appliedIds: string[] = [];
  let mirrorWriteThroughStale = 0;
  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    for (const target of targets) {
      if (add.length > 0) await mutator.addFlags(target, add);
      if (remove.length > 0) await mutator.removeFlags(target, remove);
      const wrote = await writeFlagsThrough(repository, target.messageId, target.accountId, add, remove);
      if (!wrote) mirrorWriteThroughStale += 1;
      appliedIds.push(target.messageId);
    }
  } finally {
    await closeImap(mutator);
  }

  return {
    seedMessageId: messageId,
    messageCount: appliedIds.length,
    added: add,
    removed: remove,
    messageIds: appliedIds,
    mirrorWriteThroughStale,
    truncated
  };
}

export interface ThreadMoveResult {
  seedMessageId: string;
  toFolder: string;
  messageCount: number;
  messageIds: string[];
  /** True when the thread exceeded MAX_THREAD_FANOUT and only the oldest N members
   * were considered. */
  truncated: boolean;
}

/** Move a whole thread into `destination`: move every live message in the thread,
 * each by its own folder + UID. Skips members already in the destination. */
export async function moveThread(
  pool: PgPool,
  config: AppConfig,
  messageId: string,
  destination: string,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<ThreadMoveResult> {
  if (!destination || destination.trim().length === 0) {
    throw new Error("moveThread requires a non-empty destination folder");
  }
  const repository = new MirrorRepository(pool, config, metadataProtection);
  const { accountId, targets, truncated } = await resolveThreadTargets(pool, messageId, metadataProtection);
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
    await closeImap(mutator);
  }

  return { seedMessageId: messageId, toFolder: destination, messageCount: moved.length, messageIds: moved, truncated };
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
  path: string,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<FolderMutationResult> {
  if (!path || path.trim().length === 0) throw new Error("createFolder requires a non-empty path");
  const repository = new MirrorRepository(pool, config, metadataProtection);
  const account = await repository.getAccount(accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    const result = await mutator.createFolder(path);
    return { accountId, path: result.path, created: result.created };
  } finally {
    await closeImap(mutator);
  }
}

export async function renameFolder(
  pool: PgPool,
  config: AppConfig,
  accountId: string,
  path: string,
  newPath: string,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<FolderMutationResult> {
  if (!path || !newPath) throw new Error("renameFolder requires both path and newPath");
  const repository = new MirrorRepository(pool, config, metadataProtection);
  const account = await repository.getAccount(accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    const result = await mutator.renameFolder(path, newPath);
    return { accountId, path: result.path, newPath: result.newPath };
  } finally {
    await closeImap(mutator);
  }
}

export async function deleteFolder(
  pool: PgPool,
  config: AppConfig,
  accountId: string,
  path: string,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<FolderMutationResult> {
  if (!path || path.trim().length === 0) throw new Error("deleteFolder requires a non-empty path");
  const repository = new MirrorRepository(pool, config, metadataProtection);
  const account = await repository.getAccount(accountId);
  if (!account) throw new Error(`Account not found: ${accountId}`);

  const mutator = await MailboxMutator.connect(pool, config, account);
  try {
    const result = await mutator.deleteFolder(path);
    return { accountId, path: result.path };
  } finally {
    await closeImap(mutator);
  }
}
