import { z } from "zod";
import type { PgClient, PgPool } from "../../db.js";
import type { SyncTrust } from "../../search/index.js";
import { buildSyncTrust } from "../../search/index.js";
import { threadMembershipClause, threadSeedKeys, type ThreadSeedRow } from "../../thread-walk.js";
import type { MessageAttachment, MessageDetail, MessageDetailRow, ToolDefinition, ToolEntry } from "../shared.js";
import { ATTACHMENTS_AGG, mapMessageRow, toolError, withReadOnlyTx } from "../shared.js";

/**
 * `read_thread` — reassemble a conversation from the mirror and return every
 * message in it, oldest first, with cleaned bodies and a flat attachments index.
 *
 * Seed by a `message_id` (any message in the thread) or directly by a
 * `thread_id` (`provider_thread_id`). When seeded by message id we follow I3's
 * one-hop references walk: the seed's `provider_thread_id` (when present), its
 * own id, and the normalized id-token set drawn from its
 * `references_header` + `in_reply_to` + `rfc_message_id`. This is a single hop —
 * it catches direct parents/children and provider-threaded siblings, not a full
 * transitive reference closure.
 *
 * Read-only by construction (SELECTs inside {@link withReadOnlyTx}); never sends,
 * moves, or mutates mail.
 */

const DEFAULT_MAX_MESSAGES = 20;
const MAX_MESSAGES_CEILING = 100;

/** The fields each thread message selects: the {@link MessageDetailRow} columns
 * a tool needs to call {@link mapMessageRow}, plus `internal_date` for ORDER BY.
 * Attachments use the shared {@link ATTACHMENTS_AGG} fragment (alias `m`). */
const THREAD_SELECT = `
  m.id,
  m.account_id,
  m.folder_path,
  m.provider_thread_id,
  m.subject,
  m.from_email,
  m.from_name,
  m.to_emails,
  m.cc_emails,
  m.flags,
  m.window_status,
  m.internal_date,
  b.body_text,
  b.body_plain,
  b.selected_text_part,
  ${ATTACHMENTS_AGG}
`;

type ThreadRow = MessageDetailRow;

/** The seed message's threading fields. Aliased to the shared {@link ThreadSeedRow}
 * (CC-3) so read and write resolve the same seed shape. */
type SeedRow = ThreadSeedRow;

export interface ReadThreadArgs {
  message_id?: string;
  thread_id?: string;
  account?: string;
  include_quoted?: boolean;
  max_messages?: number;
}

/**
 * Strict input schema for `read_thread` (matches the list_folders validate
 * pattern). Only `account` is a UUID; `thread_id` is a provider_thread_id
 * (free-form text), so it is NOT uuid-validated. The "message_id OR thread_id"
 * requirement is enforced separately so it returns a clearer hint.
 */
export const readThreadRequestSchema = z
  .object({
    message_id: z.string().optional(),
    thread_id: z.string().optional(),
    account: z.string().uuid().optional(),
    include_quoted: z.boolean().optional(),
    max_messages: z.number().optional()
  })
  .strict();

export interface ReadThreadResult {
  thread: {
    provider_thread_id: string | null;
    subject: string | null;
    participants: string[];
    message_count: number;
  };
  messages: MessageDetail[];
  attachments_index: Array<{ message_id: string } & MessageAttachment>;
  omitted_message_count: number;
  sync_trust: SyncTrust;
}

export const readThreadDefinition: ToolDefinition = {
  name: "read_thread",
  title: "Read a full email thread (read-only)",
  description:
    "Reassemble and read a whole conversation from the SupaMail mirror. Provide either a " +
    "message_id (any message in the thread, used as the seed) OR a thread_id " +
    "(provider_thread_id). Returns the thread's messages oldest-first with cleaned plain-text " +
    "bodies (quoted reply tails and signatures stripped unless include_quoted=true), the " +
    "distinct participants, a flat attachments_index, and a sync_trust block. Threading is a " +
    "ONE-HOP references walk (seed's provider_thread_id + its own id + the normalized " +
    "Message-Id/In-Reply-To/References tokens) — it catches direct parents, children, and " +
    "provider-threaded siblings, not a full transitive reference closure. Capped to " +
    "max_messages (default 20), keeping the NEWEST when over the cap; omitted_message_count " +
    "reports how many were dropped. READ-ONLY: never sends, deletes, moves, or modifies mail.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    anyOf: [{ required: ["message_id"] }, { required: ["thread_id"] }],
    properties: {
      message_id: {
        type: "string",
        description: "A message UUID to seed the thread from (any message in the conversation)."
      },
      thread_id: {
        type: "string",
        description: "A provider_thread_id to select the thread directly (alternative to message_id)."
      },
      account: {
        type: "string",
        description: "Optional account UUID to scope to. Defaults to the seed message's account."
      },
      include_quoted: {
        type: "boolean",
        default: false,
        description: "Keep quoted reply tails and signatures in each body (default false strips them)."
      },
      max_messages: {
        type: "integer",
        minimum: 1,
        maximum: MAX_MESSAGES_CEILING,
        default: DEFAULT_MAX_MESSAGES,
        description: "Max messages to return, keeping the newest when over the cap (default 20)."
      }
    }
  }
};

/** Distinct, order-preserving non-null participant addresses (from ∪ to ∪ cc). */
function collectParticipants(rows: ThreadRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const addrs = [row.from_email, ...(row.to_emails ?? []), ...(row.cc_emails ?? [])];
    for (const addr of addrs) {
      if (!addr) continue;
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(addr);
    }
  }
  return out;
}

async function fetchThreadRows(
  client: PgClient,
  selector: { kind: "thread"; threadId: string; accountId: string | null } | { kind: "keys"; seed: SeedRow }
): Promise<ThreadRow[]> {
  if (selector.kind === "thread") {
    const result = await client.query<ThreadRow>(
      `
      SELECT ${THREAD_SELECT}
      FROM public.imap_messages m
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
      WHERE m.provider_thread_id = $1
        AND ($2::uuid IS NULL OR m.account_id = $2)
        AND m.deleted_in_provider = false
      ORDER BY m.internal_date ASC, m.id ASC
      `,
      [selector.threadId, selector.accountId]
    );
    return result.rows;
  }

  const seed = selector.seed;
  // Shared one-hop membership walk (CC-3, thread-walk.ts): the normalized key set,
  // the WHERE predicate, and the oldest-first ORDER are single-sourced so this read
  // surface and the write fan-out (resolveThreadTargets) can never diverge on "what
  // is in a thread." This SELECT keeps its OWN columns + body JOIN (alias `m`).
  const keys = threadSeedKeys(seed);
  const result = await client.query<ThreadRow>(
    `
    SELECT ${THREAD_SELECT}
    FROM public.imap_messages m
    LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
    WHERE ${threadMembershipClause("m")}
    `,
    [seed.account_id, seed.provider_thread_id, seed.id, keys]
  );
  return result.rows;
}

export async function runReadThread(pool: PgPool, args: unknown): Promise<ReadThreadResult | ReturnType<typeof toolError>> {
  let input: ReadThreadArgs;
  try {
    input = readThreadRequestSchema.parse(args ?? {});
  } catch (error) {
    return toolError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid arguments.",
      "Pass message_id (any message in the thread) or thread_id (provider_thread_id); account must be a UUID."
    );
  }

  const messageId = typeof input.message_id === "string" ? input.message_id : undefined;
  const threadId = typeof input.thread_id === "string" ? input.thread_id : undefined;

  if (!messageId && !threadId) {
    return toolError(
      "invalid_input",
      "read_thread requires message_id or thread_id.",
      "Pass message_id (any message in the thread) or thread_id (provider_thread_id)."
    );
  }

  const includeQuoted = input.include_quoted === true;
  const accountScope = typeof input.account === "string" ? input.account : null;
  // Number.isFinite guards NaN/Infinity so the newest-keeping cap is never
  // silently disabled; non-finite falls back to the default.
  const requestedMax = Number.isFinite(input.max_messages as number) ? (input.max_messages as number) : DEFAULT_MAX_MESSAGES;
  const maxMessages = Math.max(1, Math.min(MAX_MESSAGES_CEILING, Math.floor(requestedMax)));

  return withReadOnlyTx(pool, async (client) => {
    let rows: ThreadRow[];
    let accountIds: string[] | null;

    if (threadId) {
      rows = await fetchThreadRows(client, { kind: "thread", threadId, accountId: accountScope });
      accountIds = accountScope ? [accountScope] : null;
    } else {
      const seedResult = await client.query<SeedRow>(
        `
        SELECT id, provider_thread_id, rfc_message_id, message_id_normalized,
               in_reply_to, references_header, account_id
        FROM public.imap_messages
        WHERE id = $1
          AND ($2::uuid IS NULL OR account_id = $2)
          AND deleted_in_provider = false
        `,
        [messageId, accountScope]
      );
      const seed = seedResult.rows[0];
      if (!seed) {
        return toolError(
          "not_found",
          `No message found for id ${messageId}.`,
          "Check the message_id (a UUID from search_email) or scope account. The message may be deleted in the provider."
        );
      }
      rows = await fetchThreadRows(client, { kind: "keys", seed });
      accountIds = [seed.account_id];
    }

    // sync_trust computed inside the open tx (buildSyncTrust) to avoid a second connection; syncTrustFor is the standalone equivalent.
    const syncTrust = await buildSyncTrust(client, accountIds);

    const totalCount = rows.length;
    // Cap keeping the NEWEST messages, then restore ascending (oldest-first) order.
    const kept = totalCount > maxMessages ? rows.slice(totalCount - maxMessages) : rows;
    const omitted = totalCount - kept.length;

    const messages = kept.map((row) => mapMessageRow(row, { includeQuoted }));
    const attachmentsIndex = messages.flatMap((message) =>
      message.attachments.map((att) => ({ message_id: message.message_id, ...att }))
    );

    // Representative subject = the newest message's; thread handle = its provider_thread_id.
    const newest = rows[rows.length - 1];
    const providerThreadId = newest?.provider_thread_id ?? (threadId ?? null);
    const subject = newest?.subject ?? null;

    return {
      thread: {
        provider_thread_id: providerThreadId,
        subject,
        participants: collectParticipants(rows),
        message_count: totalCount
      },
      messages,
      attachments_index: attachmentsIndex,
      omitted_message_count: omitted,
      sync_trust: syncTrust
    };
  });
}

export const readThreadEntry: ToolEntry = {
  definition: readThreadDefinition,
  handler: (pool, args) => runReadThread(pool, args)
};
