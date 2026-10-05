import { z } from "zod";
import type { PgClient, PgPool } from "../../db.js";
import { formatZodIssues } from "../../errors.js";
import { readAccountsFor, toolError, withReadOnlyTx } from "../shared.js";
import type { ToolDefinition, ToolEntry } from "../shared.js";
import {
  plaintextMetadataProtection,
  type MetadataProtectionAdapter
} from "../../metadata-protection.js";

/**
 * `list_folders` — the agent's "orient" tool. Reads every tracked folder row
 * with its stored live message and unread counts, sums the listed folders into
 * totals, and names the accounts listed, like every read tool.
 * READ-ONLY: a single SELECT over folder rows, nothing else.
 *
 * Counts (spec I1/I4) are kept exact in `imap_folder_message_counts` by
 * statement triggers on `imap_messages` (migration 0028): soft-deleted rows
 * (`deleted_in_provider = true`) never count, and `unread` excludes the IMAP
 * `\Seen` flag. The join is `(account_id, path = folder_path)`. Every synced
 * folder is listed, and an untracked (excluded or missing) folder is listed
 * while it still holds live mirrored mail.
 */

/** Validated input. `account` scopes to one account UUID; omit for every account. */
export const listFoldersRequestSchema = z
  .object({
    account: z.string().optional()
  })
  .strict();

interface FolderRow {
  account_id: string;
  path: string;
  special_use: string | null;
  status: string | null;
  total: number;
  unread: number;
}

interface ListFoldersResponse {
  folders: FolderRow[];
  totals: { total: number; unread: number };
  accounts: Awaited<ReturnType<typeof readAccountsFor>>;
}

/** The MCP tool definition (literal JSON Schema), mirroring `search_email`'s shape. */
export const listFoldersDefinition: ToolDefinition = {
  name: "list_folders",
  title: "List mailbox folders with live counts (read-only)",
  description:
    "Orient in the mirror: list every synced folder, including empty ones, with its live message " +
    "total and unread count, plus totals (total, unread) summed over the listed folders. Counts " +
    "are over the non-deleted live mirror in Postgres; unread excludes the IMAP \\Seen flag. " +
    "A folder excluded from sync is listed only while it still holds mirrored mail. Each folder carries its IMAP " +
    "special_use (e.g. \\Inbox, \\Sent, \\Trash) and sync status. Scope to one account UUID via " +
    "`account`, or omit to aggregate across all accounts (each folder row keeps its account_id). " +
    "Names the accounts listed; a notice appears only when a mailbox cannot give a complete " +
    "answer. READ-ONLY: never sends, " +
    "deletes, moves, or modifies mail.",
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
        description: "Account UUID to scope to. Omit to aggregate across every account in this database."
      }
    }
  }
};

/**
 * Read folder rows with their stored counts in one read-only transaction;
 * the account names come from their own. Empty result is not an error.
 */
export async function runListFolders(
  pool: PgPool,
  args: unknown,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<ListFoldersResponse | ReturnType<typeof toolError>> {
  const parsed = listFoldersRequestSchema.safeParse(args);
  if (!parsed.success) {
    return toolError(
      "invalid_input",
      formatZodIssues(parsed.error),
      "Pass an optional { account } UUID string, or no arguments to list folders for every account."
    );
  }
  const request = parsed.data;

  const accountId = request.account ?? null;

  const folders = await withReadOnlyTx(pool, async (client: PgClient) => {
    // `$1` is null when no account scope is requested.
    const result = await client.query<FolderRow>(
      `
      SELECT f.account_id, f.path, f.special_use, f.status,
             coalesce(c.message_count, 0) AS total,
             coalesce(c.unread_count, 0) AS unread
      FROM public.imap_folders f
      LEFT JOIN public.imap_folder_message_counts c
        ON c.account_id = f.account_id
       AND c.folder_path = f.path
      WHERE (f.tracked = true OR c.message_count > 0)
        AND ($1::uuid IS NULL OR f.account_id = $1::uuid)
      ORDER BY f.account_id, f.path
      `,
      [accountId]
    );
    return result.rows;
  });

  const totals = {
    total: folders.reduce((sum, folder) => sum + folder.total, 0),
    unread: folders.reduce((sum, folder) => sum + folder.unread, 0)
  };

  const accounts = await readAccountsFor(
    pool,
    accountId ? [accountId] : null,
    metadataProtection
  );

  return { folders, totals, accounts };
}

/** Registry entry; the server reads `definition` for tools/list and runs `handler` for tools/call. */
export const listFoldersEntry: ToolEntry = {
  definition: listFoldersDefinition,
  handler: (pool, args) => runListFolders(pool, args)
};
