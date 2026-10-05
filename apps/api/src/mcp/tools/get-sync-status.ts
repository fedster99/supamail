import { z } from "zod";
import type { PgClient, PgPool } from "../../db.js";
import { formatZodIssues } from "../../errors.js";
import { buildSyncStatus, type SyncStatus } from "../../search/index.js";
import { toolError, withReadOnlyTx } from "../shared.js";
import type { ToolDefinition, ToolEntry } from "../shared.js";
import {
  plaintextMetadataProtection,
  type MetadataProtectionAdapter
} from "../../metadata-protection.js";

/**
 * `get_sync_status` — the full sync report, on request. Read tools only name
 * their accounts (with a notice when a mailbox cannot answer completely); this
 * tool adds each mailbox's state, last sync, progress percentages, and a
 * one-line summary. It reads every recent message's body state, so it is its
 * own call rather than part of every read. READ-ONLY.
 */

/** Validated input. `account` scopes to one account UUID; omit for every account. */
export const getSyncStatusRequestSchema = z
  .object({
    account: z.string().uuid().optional()
  })
  .strict();

export const getSyncStatusDefinition: ToolDefinition = {
  name: "get_sync_status",
  title: "Check how up to date the mirrored mail is (read-only)",
  description:
    "Report each mailbox's sync state, last sync time, the share of recent mail and bodies stored, " +
    "whether older mail is still being stored, and a one-line summary. Call it only when the user " +
    "asks about syncing or results seem to be missing; read results already carry a notice when a " +
    "mailbox cannot give a complete answer. Scope to one account UUID via `account`, or omit for " +
    "every account. READ-ONLY: never sends, deletes, moves, or modifies mail.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      account: {
        type: "string",
        format: "uuid",
        description: "Account UUID to scope to. Omit to report every account."
      }
    }
  }
};

export async function runGetSyncStatus(
  pool: PgPool,
  args: unknown,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<SyncStatus | ReturnType<typeof toolError>> {
  const parsed = getSyncStatusRequestSchema.safeParse(args);
  if (!parsed.success) {
    return toolError(
      "invalid_input",
      formatZodIssues(parsed.error),
      "Pass an optional { account } UUID string, or no arguments to report every account."
    );
  }
  const accountId = parsed.data.account ?? null;
  const status = await withReadOnlyTx(pool, (client: PgClient) =>
    buildSyncStatus(client, accountId ? [accountId] : null, metadataProtection)
  );
  if (accountId && status.accounts.length === 0) {
    return toolError(
      "not_found",
      `No mailbox with account id ${accountId}.`,
      "Call list_folders for valid account ids, or omit account to report every mailbox."
    );
  }
  return status;
}

/** Registry entry; the server reads `definition` for tools/list and runs `handler` for tools/call. */
export const getSyncStatusEntry: ToolEntry = {
  definition: getSyncStatusDefinition,
  handler: (pool, args) => runGetSyncStatus(pool, args)
};
