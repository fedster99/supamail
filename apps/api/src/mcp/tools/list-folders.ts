import { z } from "zod";
import type { PgClient, PgPool } from "../../db.js";
import { syncTrustFor, toolError, withReadOnlyTx } from "../shared.js";
import type { ToolDefinition, ToolEntry } from "../shared.js";

/**
 * `list_folders` — the agent's "orient" tool. One aggregate scan over the live
 * mirror (`imap_messages`) returns every folder with live total/unread counts,
 * plus account-wide total/unread/flagged totals, left-joined to `imap_folders`
 * for `special_use` and sync `status`. Reuses the same honest `sync_trust`
 * signal as search. READ-ONLY: a single GROUP BY SELECT, nothing else.
 *
 * Counts (spec I1/I4): soft-deleted rows (`deleted_in_provider = true`) never
 * count. `unread` excludes the IMAP `\Seen` flag; `flagged` requires `\Flagged`.
 * Flags are stored verbatim from imapflow, so the predicate is exact-case. The
 * folder join is `(account_id, path = folder_path)` — NEVER `folder_id` (the
 * mirror keeps folder_id only loosely consistent; folder_path is canonical).
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
  totals: { total: number; unread: number; flagged: number };
  sync_trust: Awaited<ReturnType<typeof syncTrustFor>>;
}

/** The raw aggregate row (counts arrive as strings from pg). */
interface FolderAggRow {
  account_id: string;
  folder_path: string;
  special_use: string | null;
  status: string | null;
  total: string | number;
  unread: string | number;
}

interface TotalsRow {
  total: string | number;
  unread: string | number;
  flagged: string | number;
}

/** The MCP tool definition (literal JSON Schema), mirroring `search_email`'s shape. */
export const listFoldersDefinition: ToolDefinition = {
  name: "list_folders",
  title: "List mailbox folders with live counts (read-only)",
  description:
    "Orient in the mirror: list the folders that CONTAIN MAIL with their live message total and " +
    "unread count, plus account-wide totals (total, unread, flagged). A folder with no mirrored " +
    "messages is not listed. Counts are over the non-deleted live mirror in Postgres; unread " +
    "excludes the IMAP \\Seen flag and flagged requires \\Flagged. Each folder carries its IMAP " +
    "special_use (e.g. \\Inbox, \\Sent, \\Trash) and sync status. Scope to one account UUID via " +
    "`account`, or omit to aggregate across all accounts (each folder row keeps its account_id). " +
    "Includes a sync_trust block describing how complete the mirror is. READ-ONLY: never sends, " +
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
 * Aggregate folder counts over `imap_messages`, left-joined to `imap_folders`
 * for `special_use`/`status`. One read-only transaction; sync_trust runs in its
 * own (matching the search layer's pattern). Empty result is not an error.
 */
export async function runListFolders(pool: PgPool, args: unknown): Promise<ListFoldersResponse | ReturnType<typeof toolError>> {
  let request: z.infer<typeof listFoldersRequestSchema>;
  try {
    request = listFoldersRequestSchema.parse(args);
  } catch (error) {
    return toolError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid arguments.",
      "Pass an optional { account } UUID string, or no arguments to list folders for every account."
    );
  }

  const accountId = request.account ?? null;

  const { folders, totals } = await withReadOnlyTx(pool, async (client: PgClient) => {
    // Per-folder live counts. I1/I4: deleted rows never count; unread excludes
    // \Seen. LEFT JOIN imap_folders on (account_id, path = folder_path) — NEVER
    // folder_id. `$1` is null when no account scope is requested.
    const folderResult = await client.query<FolderAggRow>(
      `
      SELECT
        m.account_id,
        m.folder_path,
        f.special_use,
        f.status,
        count(*) FILTER (WHERE m.deleted_in_provider = false) AS total,
        count(*) FILTER (
          WHERE m.deleted_in_provider = false
            AND NOT (coalesce(m.flags, '{}'::text[]) @> ARRAY['\\Seen']::text[])
        ) AS unread
      FROM public.imap_messages m
      LEFT JOIN public.imap_folders f
        ON f.account_id = m.account_id
       AND f.path = m.folder_path
      WHERE ($1::uuid IS NULL OR m.account_id = $1::uuid)
      GROUP BY m.account_id, m.folder_path, f.special_use, f.status
      ORDER BY m.account_id, m.folder_path
      `,
      [accountId]
    );

    // Account-wide totals across all folders (same delete/flag predicates).
    const totalsResult = await client.query<TotalsRow>(
      `
      SELECT
        count(*) FILTER (WHERE m.deleted_in_provider = false) AS total,
        count(*) FILTER (
          WHERE m.deleted_in_provider = false
            AND NOT (coalesce(m.flags, '{}'::text[]) @> ARRAY['\\Seen']::text[])
        ) AS unread,
        count(*) FILTER (
          WHERE m.deleted_in_provider = false
            AND coalesce(m.flags, '{}'::text[]) @> ARRAY['\\Flagged']::text[]
        ) AS flagged
      FROM public.imap_messages m
      WHERE ($1::uuid IS NULL OR m.account_id = $1::uuid)
      `,
      [accountId]
    );

    const folderRows: FolderRow[] = folderResult.rows.map((row) => ({
      account_id: row.account_id,
      path: row.folder_path,
      special_use: row.special_use,
      status: row.status,
      total: Number(row.total),
      unread: Number(row.unread)
    }));

    const t = totalsResult.rows[0];
    const totalsOut = {
      total: Number(t?.total ?? 0),
      unread: Number(t?.unread ?? 0),
      flagged: Number(t?.flagged ?? 0)
    };

    return { folders: folderRows, totals: totalsOut };
  });

  const sync_trust = await syncTrustFor(pool, accountId ? [accountId] : null);

  return { folders, totals, sync_trust };
}

/** Registry entry; the server reads `definition` for tools/list and runs `handler` for tools/call. */
export const listFoldersEntry: ToolEntry = {
  definition: listFoldersDefinition,
  handler: (pool, args) => runListFolders(pool, args)
};
