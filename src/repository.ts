import type { AppConfig } from "./config.js";
import { encryptPassword } from "./crypto.js";
import type { PgPool } from "./db.js";
import { getProviderProfile } from "./provider-profiles.js";
import type {
  BodyFetchPolicy,
  CreateAccountInput,
  ImapAccount,
  ImapFolder,
  ImapMessage,
  MessageBodyInput,
  MessageMetadata,
  SyncResult,
  SyncRunStatus,
  SyncTriggerType
} from "./types.js";

export class MirrorRepository {
  constructor(
    private readonly pool: PgPool,
    private readonly config: AppConfig
  ) {}

  async createAccount(input: CreateAccountInput): Promise<ImapAccount> {
    const encrypted = await encryptPassword(this.pool, input.password, this.config.IMAP_ENCRYPTION_KEY);
    const result = await this.pool.query<ImapAccount>(
      `
      INSERT INTO public.imap_accounts (
        email_address,
        provider_profile,
        host,
        port,
        secure,
        username,
        encrypted_password,
        body_fetch_policy
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        input.emailAddress,
        input.providerProfile ?? "generic-imap",
        input.host,
        input.port,
        input.secure ?? true,
        input.username,
        encrypted,
        input.bodyFetchPolicy ?? this.config.BODY_FETCH_POLICY
      ]
    );
    return result.rows[0];
  }

  async listAccounts(): Promise<ImapAccount[]> {
    const result = await this.pool.query<ImapAccount>(
      "SELECT * FROM public.imap_accounts ORDER BY email_address"
    );
    return result.rows;
  }

  async getAccount(id: string): Promise<ImapAccount | null> {
    const result = await this.pool.query<ImapAccount>(
      "SELECT * FROM public.imap_accounts WHERE id = $1",
      [id]
    );
    return result.rows[0] ?? null;
  }

  async getRunnableAccounts(limit = 25): Promise<ImapAccount[]> {
    const result = await this.pool.query<ImapAccount>(
      `
      SELECT *
      FROM public.imap_accounts
      WHERE sync_state != 'PAUSED'
        AND (backoff_until IS NULL OR backoff_until <= now())
        AND currently_syncing = false
      ORDER BY COALESCE(last_sync_finished_at, 'epoch'::timestamptz), created_at
      LIMIT $1
      `,
      [limit]
    );
    return result.rows;
  }

  async startSyncRun(accountId: string, triggerType: SyncTriggerType): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `
      INSERT INTO public.imap_sync_runs (account_id, trigger_type)
      VALUES ($1, $2)
      RETURNING id
      `,
      [accountId, triggerType]
    );
    return result.rows[0].id;
  }

  async finishSyncRun(result: SyncResult): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_sync_runs
      SET
        status = $2,
        finished_at = now(),
        folders_processed = $3,
        messages_upserted = $4,
        bodies_fetched = $5,
        flags_updated = $6,
        reconcile_gaps_found = $7,
        error = $8,
        metadata = $9
      WHERE id = $1
      `,
      [
        result.runId,
        result.outcome,
        result.foldersProcessed,
        result.messagesUpserted,
        result.bodiesFetched,
        result.flagsUpdated,
        result.reconcileGapsFound,
        result.errors[0] ?? null,
        JSON.stringify({ errors: result.errors })
      ]
    );
  }

  async updateSyncRunStatus(runId: string, status: SyncRunStatus, error?: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_sync_runs
      SET status = $2, finished_at = CASE WHEN $2 != 'running' THEN now() ELSE finished_at END, error = $3
      WHERE id = $1
      `,
      [runId, status, error ?? null]
    );
  }

  async markAccountSyncStarted(accountId: string, startedBy: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_accounts
      SET
        currently_syncing = true,
        sync_started_by = $2,
        last_sync_started_at = now(),
        last_heartbeat_at = now()
      WHERE id = $1
      `,
      [accountId, startedBy]
    );
  }

  async markAccountSyncSucceeded(accountId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_accounts
      SET
        currently_syncing = false,
        sync_started_by = NULL,
        last_sync_finished_at = now(),
        last_heartbeat_at = now(),
        sync_state = CASE WHEN sync_state = 'INITIAL_SYNC' THEN 'HEALTHY' ELSE sync_state END,
        sync_state_reason = NULL,
        consecutive_successes = consecutive_successes + 1,
        consecutive_failures = 0,
        current_backoff_ms = 0,
        backoff_until = NULL
      WHERE id = $1
      `,
      [accountId]
    );
  }

  async markAccountSyncFailed(accountId: string, error: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_accounts
      SET
        currently_syncing = false,
        sync_started_by = NULL,
        last_sync_finished_at = now(),
        sync_state = CASE WHEN consecutive_failures >= 4 THEN 'BROKEN' ELSE 'DEGRADED' END,
        sync_state_reason = $2,
        consecutive_failures = consecutive_failures + 1,
        consecutive_successes = 0,
        current_backoff_ms = LEAST(GREATEST(current_backoff_ms * 2, 60000), 3600000),
        backoff_until = now() + (LEAST(GREATEST(current_backoff_ms * 2, 60000), 3600000) * interval '1 millisecond')
      WHERE id = $1
      `,
      [accountId, error.slice(0, 1000)]
    );
  }

  async heartbeat(accountId: string): Promise<void> {
    await this.pool.query("UPDATE public.imap_accounts SET last_heartbeat_at = now() WHERE id = $1", [
      accountId
    ]);
  }

  async upsertDiscoveredFolders(
    account: ImapAccount,
    folders: Array<{ path: string; delimiter?: string | null; specialUse?: string | null }>
  ): Promise<ImapFolder[]> {
    const profile = getProviderProfile(account.provider_profile);
    const rows: ImapFolder[] = [];
    const seen = new Set<string>();

    for (const folder of folders) {
      seen.add(folder.path);
      const excludedReason = profile.excludedReason(folder.path, folder.specialUse);
      const result = await this.pool.query<ImapFolder>(
        `
        INSERT INTO public.imap_folders (
          account_id,
          path,
          delimiter,
          special_use,
          last_seen_in_provider_at,
          tracked,
          excluded_reason,
          sync_priority,
          status
        )
        VALUES ($1, $2, $3, $4, now(), $5, $6, $7, CASE WHEN $5 THEN 'PENDING' ELSE 'ACTIVE' END)
        ON CONFLICT (account_id, path)
        DO UPDATE SET
          delimiter = EXCLUDED.delimiter,
          special_use = EXCLUDED.special_use,
          last_seen_in_provider_at = now(),
          missing_since = NULL,
          tracked = EXCLUDED.tracked,
          excluded_reason = EXCLUDED.excluded_reason,
          sync_priority = EXCLUDED.sync_priority,
          status = CASE WHEN public.imap_folders.status = 'MISSING' THEN 'PENDING' ELSE public.imap_folders.status END
        RETURNING *
        `,
        [
          account.id,
          folder.path,
          folder.delimiter ?? null,
          folder.specialUse ?? null,
          excludedReason === null,
          excludedReason,
          profile.priorityForFolder(folder.path, folder.specialUse)
        ]
      );
      rows.push(result.rows[0]);
    }

    await this.pool.query(
      `
      UPDATE public.imap_folders
      SET status = 'MISSING',
          missing_since = COALESCE(missing_since, now()),
          tracked = false
      WHERE account_id = $1
        AND NOT (path = ANY($2::text[]))
        AND status != 'MISSING'
      `,
      [account.id, [...seen]]
    );

    await this.pool.query(
      `
      UPDATE public.imap_accounts
      SET last_folder_discovery_at = now(),
          next_folder_discovery_at = now() + ($2 * interval '1 millisecond')
      WHERE id = $1
      `,
      [account.id, this.config.FOLDER_DISCOVERY_INTERVAL_MS]
    );

    return rows;
  }

  async getFoldersDueForSync(accountId: string, limit = 25): Promise<ImapFolder[]> {
    const result = await this.pool.query<ImapFolder>(
      `
      SELECT *
      FROM public.imap_folders
      WHERE account_id = $1
        AND tracked = true
        AND status != 'MISSING'
        AND (next_sync_due_at IS NULL OR next_sync_due_at <= now())
      ORDER BY sync_priority, COALESCE(last_synced_at, 'epoch'::timestamptz), path
      LIMIT $2
      `,
      [accountId, limit]
    );
    return result.rows;
  }

  async markFolderSyncStarted(folderId: string): Promise<void> {
    await this.pool.query(
      "UPDATE public.imap_folders SET status = 'SYNCING', last_progress_at = now() WHERE id = $1",
      [folderId]
    );
  }

  async markFolderSynced(folderId: string, patch: {
    uidValidity: number;
    uidNext?: number;
    lastUid?: number;
    initialComplete?: boolean;
  }): Promise<void> {
    await this.pool.query(
      `
      UPDATE public.imap_folders
      SET
        status = 'ACTIVE',
        uidvalidity = $2,
        uid_next = COALESCE($3, uid_next),
        last_uid = COALESCE($4, last_uid),
        initial_sync_complete = COALESCE($5, initial_sync_complete),
        last_synced_at = now(),
        next_sync_due_at = now() + interval '1 minute',
        next_flag_scan_at = COALESCE(next_flag_scan_at, now() + interval '10 minutes'),
        next_reconcile_at = COALESCE(next_reconcile_at, now() + interval '6 hours')
      WHERE id = $1
      `,
      [folderId, patch.uidValidity, patch.uidNext ?? null, patch.lastUid ?? null, patch.initialComplete ?? null]
    );
  }

  async handleUidValidityReset(account: ImapAccount, folder: ImapFolder, newUidValidity: number): Promise<void> {
    const client = await this.pool.connect();
    await client.query("BEGIN");
    try {
      await client.query(
        `
        UPDATE public.imap_messages
        SET deleted_in_provider = true,
            provider_deleted_at = now(),
            deleted_reason = 'UIDVALIDITY_RESET'
        WHERE account_id = $1
          AND folder_path = $2
          AND deleted_in_provider = false
        `,
        [account.id, folder.path]
      );
      await client.query(
        `
        UPDATE public.imap_folders
        SET uidvalidity = $3,
            last_uid = NULL,
            initial_sync_complete = false,
            status = 'NEEDS_FULL_RESYNC',
            uidvalidity_reset_count = uidvalidity_reset_count + 1,
            last_uidvalidity_reset_at = now()
        WHERE id = $1
          AND account_id = $2
        `,
        [folder.id, account.id, newUidValidity]
      );
      await client.query(
        `
        INSERT INTO public.imap_sync_events (
          account_id,
          sync_run_id,
          message_id,
          folder_path,
          provider_uid,
          event_type,
          payload
        )
        VALUES ($1, NULL, NULL, $2, NULL, 'FOLDER_RESET', $3)
        `,
        [account.id, folder.path, JSON.stringify({ reason: "UIDVALIDITY_RESET", newUidValidity })]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertMessages(
    accountId: string,
    folder: ImapFolder,
    uidValidity: number,
    messages: MessageMetadata[],
    windowCutoff: Date
  ): Promise<ImapMessage[]> {
    const rows: ImapMessage[] = [];

    for (const message of messages) {
      const result = await this.pool.query<ImapMessage>(
        `
        INSERT INTO public.imap_messages (
          account_id,
          folder_id,
          folder_path,
          uidvalidity,
          uid,
          rfc_message_id,
          message_id_normalized,
          provider_thread_id,
          in_reply_to,
          references_header,
          internal_date,
          size_bytes,
          subject,
          from_email,
          from_name,
          to_emails,
          to_names,
          cc_emails,
          cc_names,
          bcc_emails,
          flags,
          headers_json,
          mime_structure,
          window_status
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22, $23, $24
        )
        ON CONFLICT (account_id, folder_path, uidvalidity, uid)
        DO UPDATE SET
          flags = EXCLUDED.flags,
          headers_json = EXCLUDED.headers_json,
          mime_structure = EXCLUDED.mime_structure,
          deleted_in_provider = false,
          provider_deleted_at = NULL,
          deleted_reason = NULL
        RETURNING *
        `,
        [
          accountId,
          folder.id,
          folder.path,
          uidValidity,
          message.uid,
          message.rfcMessageId,
          message.messageIdNormalized,
          message.providerThreadId,
          message.inReplyTo,
          message.referencesHeader,
          message.internalDate,
          message.sizeBytes,
          message.subject,
          message.fromEmail,
          message.fromName,
          message.toEmails,
          message.toNames,
          message.ccEmails,
          message.ccNames,
          message.bccEmails,
          message.flags,
          JSON.stringify(message.headersJson),
          JSON.stringify(message.mimeStructure ?? null),
          message.internalDate < windowCutoff ? "HISTORICAL" : "IN_WINDOW"
        ]
      );

      const row = result.rows[0];
      rows.push(row);

      for (const attachment of message.attachments) {
        await this.pool.query(
          `
          INSERT INTO public.imap_attachments (
            message_id,
            filename,
            mime_type,
            size_bytes,
            part_number,
            content_id,
            disposition
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT DO NOTHING
          `,
          [
            row.id,
            attachment.filename,
            attachment.mimeType,
            attachment.sizeBytes,
            attachment.partNumber,
            attachment.contentId,
            attachment.disposition
          ]
        );
      }
    }

    return rows;
  }

  async markMissingMessages(accountId: string, folder: ImapFolder, uidValidity: number, liveUids: number[]): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `
      WITH marked AS (
        UPDATE public.imap_messages
        SET deleted_in_provider = true,
            provider_deleted_at = now(),
            deleted_reason = 'RECONCILE_MISSING'
        WHERE account_id = $1
          AND folder_path = $2
          AND uidvalidity = $3
          AND deleted_in_provider = false
          AND NOT (uid = ANY($4::bigint[]))
        RETURNING id
      )
      SELECT count(*)::text AS count FROM marked
      `,
      [accountId, folder.path, uidValidity, liveUids]
    );
    return Number(result.rows[0].count);
  }

  async getMessage(id: string): Promise<ImapMessage | null> {
    const result = await this.pool.query<ImapMessage>("SELECT * FROM public.imap_messages WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async storeBody(body: MessageBodyInput): Promise<void> {
    await this.pool.query(
      `
      WITH upsert AS (
        INSERT INTO public.imap_message_bodies (
          message_id,
          raw_mime,
          raw_bytes,
          raw_truncated,
          body_text,
          body_html,
          body_plain,
          selected_text_part,
          selected_text_format,
          headers_json,
          mime_structure,
          parser_warnings,
          fetched_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now(), now())
        ON CONFLICT (message_id)
        DO UPDATE SET
          raw_mime = EXCLUDED.raw_mime,
          raw_bytes = EXCLUDED.raw_bytes,
          raw_truncated = EXCLUDED.raw_truncated,
          body_text = EXCLUDED.body_text,
          body_html = EXCLUDED.body_html,
          body_plain = EXCLUDED.body_plain,
          selected_text_part = EXCLUDED.selected_text_part,
          selected_text_format = EXCLUDED.selected_text_format,
          headers_json = EXCLUDED.headers_json,
          mime_structure = EXCLUDED.mime_structure,
          parser_warnings = EXCLUDED.parser_warnings,
          fetched_at = now(),
          updated_at = now()
        RETURNING message_id
      )
      UPDATE public.imap_messages
      SET body_fetched_at = now()
      WHERE id IN (SELECT message_id FROM upsert)
      `,
      [
        body.messageId,
        body.rawMime,
        body.rawBytes,
        body.rawTruncated,
        body.bodyText,
        body.bodyHtml,
        body.bodyPlain,
        body.selectedTextPart,
        body.selectedTextFormat,
        JSON.stringify(body.headersJson),
        JSON.stringify(body.mimeStructure ?? null),
        body.parserWarnings
      ]
    );
  }

  async getBodyBacklog(account: ImapAccount, limit: number): Promise<ImapMessage[]> {
    const policy = account.body_fetch_policy || (this.config.BODY_FETCH_POLICY as BodyFetchPolicy);
    if (policy === "lazy") return [];

    const priorityClause = policy === "priority_then_backfill" ? "AND f.sync_priority <= $3" : "";
    const params: unknown[] = [account.id, limit];
    if (policy === "priority_then_backfill") params.push(this.config.PRIORITY_CUTOFF);

    const result = await this.pool.query<ImapMessage>(
      `
      SELECT m.*
      FROM public.imap_messages m
      JOIN public.imap_folders f ON f.account_id = m.account_id AND f.path = m.folder_path
      WHERE m.account_id = $1
        AND m.deleted_in_provider = false
        AND m.window_status = 'IN_WINDOW'
        AND m.body_fetched_at IS NULL
        ${priorityClause}
      ORDER BY f.sync_priority, m.uid DESC
      LIMIT $2
      `,
      params
    );
    return result.rows;
  }

  async logEvent(
    accountId: string,
    syncRunId: string | null,
    messageId: string | null,
    folderPath: string | null,
    providerUid: number | null,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO public.imap_sync_events (
        account_id,
        sync_run_id,
        message_id,
        folder_path,
        provider_uid,
        event_type,
        payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [accountId, syncRunId, messageId, folderPath, providerUid, eventType, JSON.stringify(payload)]
    );
  }
}
