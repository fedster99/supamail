import { z } from "zod";
import type { PgClient, PgPool } from "../../db.js";
import { formatZodIssues } from "../../errors.js";
import type { ReadAccount } from "../../search/index.js";
import { buildReadAccounts } from "../../search/index.js";
import { ACTIVE_ASSIGNMENT_JOIN, DELIVERY_KEY_SQL } from "../../delivery-identity.js";
import { extractMessageIdTokens } from "../../threading.js";
import { threadMembershipClause, threadSeedKeys, type ThreadSeedRow } from "../../thread-walk.js";
import type { MessageDetail, MessageDetailRow, ToolDefinition, ToolEntry } from "../shared.js";
import { loadMessageAttachments, mapMessageRow, toolError, withReadOnlyTx } from "../shared.js";
import {
  METADATA_PROTECTED_FIELDS,
  plaintextMetadataProtection,
  revealMetadataRecord,
  type MetadataProtectionAdapter,
  type ProtectedMetadataColumns
} from "../../metadata-protection.js";

/**
 * `read_thread` — reassemble one or more conversations from the mirror and
 * return each thread's messages oldest first, with cleaned bodies and each
 * message's attached files.
 *
 * Seed by one `message_id` (any message in the thread), 1 to 10 `message_ids`, a
 * durable `conversation_id`, or the legacy provider `thread_id`. A message with
 * a stored assignment resolves through the complete account-scoped conversation
 * and mirrored delivery copies collapse to one deterministic representative.
 * The old one-hop References walk remains only as a compatibility fallback for
 * messages that have not been assigned yet.
 *
 * A page holds the newest `max_messages` messages. When older ones remain, the
 * response carries `next_cursor` (the oldest returned message); the same
 * selector with `cursor` returns the messages before it. The boundary is that
 * message's `(internal_date, id)`, so new replies never shift an older page.
 *
 * Read-only by construction (SELECTs inside {@link withReadOnlyTx}); never sends,
 * moves, or mutates mail.
 */

const DEFAULT_MAX_MESSAGES = 20;
const MAX_MESSAGES_CEILING = 100;
const MAX_THREAD_BATCH = 10;
const THREAD_BATCH_CONCURRENCY = 4;



/**
 * One representative per delivery, plus the ids of its other stored copies.
 * `source` is a FROM clause with alias `m`; `key` is the delivery key.
 */
function deliveryRepresentativesCte(source: string, key: string): string {
  return `delivery_copies AS (
      SELECT
        m.id,
        row_number() OVER (
          PARTITION BY m.account_id, ${key}
          ORDER BY (m.body_fetched_at IS NOT NULL) DESC, m.folder_path ASC, m.id ASC
        ) AS position,
        array_agg(m.id) OVER (
          PARTITION BY m.account_id, ${key}
          ORDER BY m.id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS delivery_copy_ids
      ${source}
    ),
    delivery_representatives AS (
      SELECT id, array_remove(delivery_copy_ids, id) AS duplicate_message_ids
      FROM delivery_copies
      WHERE position = 1
    )`;
}

/** The fields each thread message selects: the {@link MessageDetailRow} columns
 * a tool needs to call {@link mapMessageRow}, plus `internal_date` for ORDER BY,
 * the reply headers that name missing ancestors, and the inline part count. */
function threadSelect(includeBody: boolean): string {
  return `
  m.id,
  m.account_id,
  m.folder_path,
  m.provider_thread_id,
  ta.conversation_id,
  m.subject,
  m.from_email,
  m.from_name,
  m.to_emails,
  m.cc_emails,
  m.flags,
  m.internal_date,
  m.rfc_message_id,
  m.in_reply_to,
  m.references_header,
  (SELECT count(*)::int FROM public.imap_attachments a
    WHERE a.message_id = m.id AND a.disposition IS DISTINCT FROM 'attachment') AS inline_count,
  m.protected_metadata,
  m.protected_metadata_version,
  m.protected_metadata_key_version,
  m.protected_metadata_tokens,
  b.raw_truncated,
  ${includeBody
    ? "b.body_text, b.body_plain, b.selected_text_part"
    : "NULL::text AS body_text, NULL::text AS body_plain, NULL::text AS selected_text_part"},
  stats.total_count AS thread_total_count,
  stats.remaining_count AS thread_remaining_count,
  stats.participants AS thread_participants,
  representative.duplicate_message_ids
`;
}

type ThreadRow = MessageDetailRow & ProtectedMetadataColumns & {
  conversation_id: string | null;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  inline_count: number;
  duplicate_message_ids: string[] | null;
  thread_total_count: number | string | null;
  thread_remaining_count: number | string | null;
  thread_participants: string[] | null;
};

interface FetchedThread {
  rows: ThreadRow[];
  /** Deliveries in the whole conversation. */
  totalCount: number;
  /** Deliveries before the cursor (the whole conversation without one). */
  remainingCount: number;
  participants: string[];
}

/** The seed message's threading fields. Aliased to the shared {@link ThreadSeedRow}
 * (CC-3) so read and write resolve the same seed shape. */
type SeedRow = ThreadSeedRow & { conversation_id: string | null };

export interface ReadThreadArgs {
  message_id?: string;
  message_ids?: string[];
  conversation_id?: string;
  thread_id?: string;
  account?: string;
  include_quoted?: boolean;
  max_messages?: number;
  cursor?: string;
}

/**
 * Library-only switch for hosted callers that hydrate complete bodies from their
 * own body store. The public MCP tool always leaves this enabled.
 */
export interface ReadThreadOptions {
  includeBody?: boolean;
}

/**
 * Strict input schema for `read_thread` (matches the list_folders validate
 * pattern). Only `account` is a UUID; provider and durable conversation ids are
 * opaque text, so they are NOT uuid-validated. The selector requirement is
 * enforced separately so it returns a clearer hint.
 */
export const readThreadRequestSchema = z
  .object({
    message_id: z.string().uuid().optional(),
    message_ids: z.array(z.string().uuid()).min(1).max(MAX_THREAD_BATCH).optional(),
    conversation_id: z.string().optional(),
    thread_id: z.string().optional(),
    account: z.string().uuid().optional(),
    include_quoted: z.boolean().optional(),
    max_messages: z.number().int().min(1).max(MAX_MESSAGES_CEILING).optional(),
    cursor: z.string().uuid().optional()
  })
  .strict();

export interface ReadThreadResult {
  thread: {
    conversation_id: string | null;
    /** Omitted when the provider has no thread handle. */
    provider_thread_id?: string;
    subject: string | null;
    participants: string[];
    message_count: number;
  };
  messages: MessageDetail[];
  /** Messages older than the returned ones that this page left out. */
  omitted_message_count: number;
  /** Pass as `cursor` with the same selector to read the older messages. Present only when some remain. */
  next_cursor?: string;
  /** Earlier messages the oldest returned message replies to that are not in the mirror. Present only when > 0. */
  missing_ancestor_count?: number;
  thread_content_status: "complete" | "partial";
  thread_omissions: Array<"older_messages" | "ancestors_not_mirrored">;
  accounts: ReadAccount[];
}

export interface ReadThreadBatchResult {
  threads: Array<
    | { message_id: string; result: ReadThreadResult }
    | { message_id: string; same_thread_as: string }
    | { message_id: string; error: ReturnType<typeof toolError>["error"] }
  >;
}

export const readThreadDefinition: ToolDefinition = {
  name: "read_thread",
  title: "Read one or more email threads (read-only)",
  description:
    "Read one conversation from the SupaMail mirror, or up to 10 in one call. Select it with message_id " +
    "(any message in the conversation), message_ids (1 to 10 seeds), or an account-scoped conversation_id " +
    "or legacy provider thread_id; pass exactly one selector. " +
    "Returns the newest max_messages messages (default 20, maximum 100) oldest-first, each with its full " +
    "cleaned body and its attached files; a body range (body_offset, max_body_chars) exists only on read_message. " +
    "When older messages remain, omitted_message_count says how many and next_cursor continues into them: " +
    "call again with the same selector and cursor to read the messages before it; new replies do not shift that page. " +
    "thread_content_status and thread_omissions report older_messages before this page and ancestors_not_mirrored " +
    "(missing_ancestor_count) for earlier replies the mirror never held. " +
    "Replies contain newly authored plain text: recognized quoted reply tails and signatures are stripped " +
    "unless include_quoted=true. When no older messages remain, the oldest message keeps its quoted content. " +
    "Each message's body_content_status and body_omissions report absent source text; inline_count counts " +
    "inline parts such as signature images (read_message lists them). Each email appears once; " +
    "duplicate_message_ids lists its other stored copies, to move or flag every copy. " +
    "In a batch, duplicate seeds collapse in first-occurrence order; each distinct seed gets its own result " +
    "or error, or same_thread_as naming the earlier seed that already returned its conversation. " +
    "Returns the distinct participants and the accounts read. " +
    "READ-ONLY: never sends, deletes, moves, or modifies mail.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    oneOf: [
      {
        required: ["message_id"],
        not: { anyOf: [
          { required: ["message_ids"] },
          { required: ["conversation_id"] },
          { required: ["thread_id"] }
        ] }
      },
      {
        required: ["message_ids"],
        not: { anyOf: [
          { required: ["message_id"] },
          { required: ["conversation_id"] },
          { required: ["thread_id"] },
          { required: ["cursor"] }
        ] }
      },
      {
        required: ["conversation_id", "account"],
        not: { anyOf: [
          { required: ["message_id"] },
          { required: ["message_ids"] },
          { required: ["thread_id"] }
        ] }
      },
      {
        required: ["thread_id", "account"],
        not: { anyOf: [
          { required: ["message_id"] },
          { required: ["message_ids"] },
          { required: ["conversation_id"] }
        ] }
      }
    ],
    properties: {
      message_id: {
        type: "string",
        format: "uuid",
        minLength: 36,
        maxLength: 36,
        description: "A message UUID to seed the thread from (any message in the conversation)."
      },
      message_ids: {
        type: "array",
        minItems: 1,
        maxItems: MAX_THREAD_BATCH,
        items: { type: "string", format: "uuid", minLength: 36, maxLength: 36 },
        description: "One to 10 message UUIDs. Duplicate seeds are collapsed in first-occurrence order."
      },
      conversation_id: {
        type: "string",
        description: "A durable SupaMail conversation_id; account is required because ids are account-scoped."
      },
      thread_id: {
        type: "string",
        description: "A legacy provider_thread_id; account is required because provider ids are not globally unique."
      },
      account: {
        type: "string",
        description: "Optional account UUID to scope to. Defaults to the seed message's account."
      },
      include_quoted: {
        type: "boolean",
        default: false,
        description:
          "Keep quoted reply tails and signatures in every body. By default, replies are cleaned; " +
          "when no older messages were omitted, the oldest mirrored message keeps quoted content."
      },
      max_messages: {
        type: "integer",
        minimum: 1,
        maximum: MAX_MESSAGES_CEILING,
        default: DEFAULT_MAX_MESSAGES,
        description: "Messages per page (default 20, maximum 100). Keeps the newest; next_cursor continues into older ones."
      },
      cursor: {
        type: "string",
        format: "uuid",
        minLength: 36,
        maxLength: 36,
        description:
          "next_cursor from an earlier read_thread response for this conversation. Returns the messages " +
          "before it. Not accepted with message_ids."
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

/** Message-IDs the oldest message replies to that no returned message carries. */
function countMissingAncestors(rows: ThreadRow[]): number {
  const found = new Set(rows.flatMap((row) => extractMessageIdTokens(row.rfc_message_id)));
  const ancestors = new Set([
    ...extractMessageIdTokens(rows[0].references_header),
    ...extractMessageIdTokens(rows[0].in_reply_to)
  ]);
  return [...ancestors].filter((id) => !found.has(id)).length;
}

/**
 * Keep one full result per conversation in a batch. A later seed from the same
 * account-scoped conversation names the first seed instead of repeating it.
 */
function pointRepeatedConversations(
  threads: ReadThreadBatchResult["threads"]
): ReadThreadBatchResult["threads"] {
  const firstSeed = new Map<string, string>();
  return threads.map((entry) => {
    if (!("result" in entry) || !entry.result.thread.conversation_id) return entry;
    const key = `${entry.result.messages[0]?.account_id}\u0000${entry.result.thread.conversation_id}`;
    const seed = firstSeed.get(key);
    if (seed) return { message_id: entry.message_id, same_thread_as: seed };
    firstSeed.set(key, entry.message_id);
    return entry;
  });
}

/**
 * Count the full logical conversation and collect its participants, but hydrate
 * bodies/attachments for only the newest requested deliveries before the cursor.
 * The final SELECT restores oldest-first order for the public response.
 */
function boundedThreadCtes(limitParameter: string, cursorParameter: string): string {
  return `,
    remaining_representatives AS (
      SELECT representative.id, representative.duplicate_message_ids, m.internal_date
      FROM delivery_representatives representative
      JOIN public.imap_messages m ON m.id = representative.id
      WHERE ${cursorParameter}::uuid IS NULL
         OR (m.internal_date, m.id) < (
           SELECT cursor_message.internal_date, cursor_message.id
           FROM public.imap_messages cursor_message
           WHERE cursor_message.id = ${cursorParameter}
         )
    ),
    thread_stats AS (
      SELECT
        (SELECT count(*)::int FROM delivery_representatives) AS total_count,
        (SELECT count(*)::int FROM remaining_representatives) AS remaining_count,
        coalesce((
          SELECT array_agg(first_participant.email ORDER BY
            first_participant.internal_date,
            first_participant.message_id,
            first_participant.ordinality
          )
          FROM (
            SELECT DISTINCT ON (lower(participant.email))
              participant.email,
              m.internal_date,
              m.id AS message_id,
              participant.ordinality
            FROM delivery_representatives representative
            JOIN public.imap_messages m ON m.id = representative.id
            CROSS JOIN LATERAL unnest(
              ARRAY[m.from_email]::text[]
              || coalesce(m.to_emails, '{}'::text[])
              || coalesce(m.cc_emails, '{}'::text[])
            ) WITH ORDINALITY AS participant(email, ordinality)
            WHERE nullif(participant.email, '') IS NOT NULL
            ORDER BY
              lower(participant.email),
              m.internal_date,
              m.id,
              participant.ordinality
          ) first_participant
        ), '{}'::text[]) AS participants
    ),
    limited_representatives AS (
      SELECT id, duplicate_message_ids
      FROM remaining_representatives
      ORDER BY internal_date DESC, id DESC
      LIMIT ${limitParameter}
    )`;
}

function countOr(value: number | string | null | undefined, fallback: number): number {
  const count = Number(value ?? fallback);
  return Number.isFinite(count) ? count : fallback;
}

function summarizeFetchedRows(rows: ThreadRow[]): FetchedThread {
  const totalCount = countOr(rows[0]?.thread_total_count, rows.length);
  return {
    rows,
    totalCount,
    remainingCount: countOr(rows[0]?.thread_remaining_count, totalCount),
    participants: rows[0]?.thread_participants ?? collectParticipants(rows)
  };
}

async function fetchThreadRows(
  client: PgClient,
  selector:
    | { kind: "conversation"; conversationId: string; accountId: string }
    | { kind: "provider-thread"; threadId: string; accountId: string }
    | { kind: "keys"; seed: SeedRow },
  maxMessages: number,
  cursor: string | null,
  { includeBody = true }: ReadThreadOptions
): Promise<FetchedThread> {
  if (selector.kind === "conversation") {
    const result = await client.query<ThreadRow>(
      `
      WITH ${deliveryRepresentativesCte(`
        FROM public.imap_thread_active_assignments assignment
        JOIN public.imap_messages m
          ON m.id = assignment.message_id
         AND m.account_id = assignment.account_id
        WHERE assignment.account_id = $1
          AND assignment.conversation_id = $2
          AND m.deleted_in_provider = false`, "assignment.delivery_key")}${boundedThreadCtes("$3", "$4")}
      SELECT ${threadSelect(includeBody)}
      FROM limited_representatives representative
      JOIN public.imap_messages m ON m.id = representative.id
      ${ACTIVE_ASSIGNMENT_JOIN}
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
      CROSS JOIN thread_stats stats
      ORDER BY m.internal_date ASC, m.id ASC
      `,
      [selector.accountId, selector.conversationId, maxMessages, cursor]
    );
    return summarizeFetchedRows(result.rows);
  }

  if (selector.kind === "provider-thread") {
    const result = await client.query<ThreadRow>(
      `
      WITH ${deliveryRepresentativesCte(`
        FROM public.imap_messages m
        ${ACTIVE_ASSIGNMENT_JOIN}
        LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
        WHERE m.provider_thread_id = $1
          AND m.account_id = $2
          AND m.deleted_in_provider = false`, DELIVERY_KEY_SQL)}${boundedThreadCtes("$3", "$4")}
      SELECT ${threadSelect(includeBody)}
      FROM limited_representatives representative
      JOIN public.imap_messages m ON m.id = representative.id
      ${ACTIVE_ASSIGNMENT_JOIN}
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
      CROSS JOIN thread_stats stats
      ORDER BY m.internal_date ASC, m.id ASC
      `,
      [selector.threadId, selector.accountId, maxMessages, cursor]
    );
    return summarizeFetchedRows(result.rows);
  }

  const seed = selector.seed;
  // Shared one-hop membership walk (CC-3, thread-walk.ts): the strict,
  // case-preserving bracketed token set,
  // the WHERE predicate, and the oldest-first ORDER are single-sourced so this read
  // surface and the write fan-out (resolveThreadTargets) can never diverge on "what
  // is in a thread." This SELECT keeps its OWN columns + body JOIN (alias `m`).
  const keys = threadSeedKeys(seed);
  const result = await client.query<ThreadRow>(
    `
    WITH legacy_candidates AS (
      SELECT m.id
      FROM public.imap_messages m
      WHERE ${threadMembershipClause("m")}
    ),
    ${deliveryRepresentativesCte(`
      FROM legacy_candidates candidate
      JOIN public.imap_messages m ON m.id = candidate.id
      ${ACTIVE_ASSIGNMENT_JOIN}
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id`, DELIVERY_KEY_SQL)}${boundedThreadCtes("$5", "$6")}
    SELECT ${threadSelect(includeBody)}
    FROM limited_representatives representative
    JOIN public.imap_messages m ON m.id = representative.id
    ${ACTIVE_ASSIGNMENT_JOIN}
    LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
    CROSS JOIN thread_stats stats
    ORDER BY m.internal_date ASC, m.id ASC
    `,
    [seed.account_id, seed.provider_thread_id, seed.id, keys, maxMessages, cursor]
  );
  return summarizeFetchedRows(result.rows);
}

async function runReadThreadInternal(
  pool: PgPool,
  args: unknown,
  metadataProtection: MetadataProtectionAdapter,
  options: ReadThreadOptions
): Promise<ReadThreadResult | ReadThreadBatchResult | ReturnType<typeof toolError>> {
  const parsed = readThreadRequestSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return toolError(
      "invalid_input",
      formatZodIssues(parsed.error),
      "Pass message_id, message_ids, or conversation_id/thread_id together with the account UUID."
    );
  }
  const input: ReadThreadArgs = parsed.data;

  const selectorCount = [
    input.message_id,
    input.message_ids,
    input.conversation_id,
    input.thread_id
  ].filter((value) => value !== undefined).length;
  if (selectorCount > 1) {
    return toolError(
      "invalid_input",
      "read_thread accepts one selector mode at a time.",
      "Pass one message_id, one message_ids batch, or one account-scoped conversation/thread id."
    );
  }

  if (input.message_ids && input.cursor !== undefined) {
    return toolError(
      "invalid_input",
      "cursor continues one thread, not a message_ids batch.",
      "Pass cursor with the message_id, conversation_id, or thread_id that returned it."
    );
  }

  if (input.message_ids) {
    const messageIds = [...new Set(input.message_ids)];
    const threads = new Array<ReadThreadBatchResult["threads"][number]>(messageIds.length);
    let nextIndex = 0;
    // Each item owns one snapshot, including its accounts. Sharing them across
    // items could describe a different mirror state than the returned thread.
    await Promise.all(Array.from(
      { length: Math.min(THREAD_BATCH_CONCURRENCY, messageIds.length) },
      async () => {
        while (nextIndex < messageIds.length) {
          const index = nextIndex++;
          const messageId = messageIds[index];
          try {
            const result = await runReadThreadInternal(pool, {
              message_id: messageId,
              account: input.account,
              include_quoted: input.include_quoted,
              max_messages: input.max_messages
            }, metadataProtection, options);
            if ("thread" in result) {
              threads[index] = { message_id: messageId, result };
            } else if ("error" in result) {
              threads[index] = { message_id: messageId, error: result.error };
            } else {
              throw new Error("unexpected nested read_thread batch result");
            }
          } catch {
            threads[index] = {
              message_id: messageId,
              error: toolError(
                "tool_failed",
                "Thread could not be read.",
                "Retry this thread or remove it from the batch."
              ).error
            };
          }
        }
      }
    ));
    return { threads: pointRepeatedConversations(threads) };
  }

  const messageId = typeof input.message_id === "string" ? input.message_id : undefined;
  const conversationId = typeof input.conversation_id === "string" ? input.conversation_id : undefined;
  const threadId = typeof input.thread_id === "string" ? input.thread_id : undefined;

  if (!messageId && !conversationId && !threadId) {
    return toolError(
      "invalid_input",
      "read_thread requires message_id, message_ids, conversation_id, or thread_id.",
      "Pass message_id/message_ids, or pass conversation_id/thread_id together with account."
    );
  }

  const includeQuoted = input.include_quoted === true;
  const accountScope = typeof input.account === "string" ? input.account : null;
  if ((conversationId || threadId) && !accountScope) {
    return toolError(
      "invalid_input",
      `${conversationId ? "conversation_id" : "thread_id"} requires account.`,
      "Provider and conversation identifiers are account-scoped; pass account as a UUID."
    );
  }
  const maxMessages = input.max_messages ?? DEFAULT_MAX_MESSAGES;
  const cursor = input.cursor ?? null;

  return withReadOnlyTx(pool, async (client) => {
    let fetched: FetchedThread;
    let accountIds: string[] | null;

    let resolvedConversationId: string | null = conversationId ?? null;

    if (conversationId) {
      fetched = await fetchThreadRows(client, {
        kind: "conversation",
        conversationId,
        accountId: accountScope!
      }, maxMessages, cursor, options);
      accountIds = [accountScope!];
    } else if (threadId) {
      fetched = await fetchThreadRows(client, {
        kind: "provider-thread",
        threadId,
        accountId: accountScope!
      }, maxMessages, cursor, options);
      accountIds = [accountScope!];
    } else {
      const seedResult = await client.query<SeedRow>(
        `
        SELECT id, provider_thread_id, rfc_message_id, message_id_normalized,
               in_reply_to, references_header, m.account_id,
               assignment.conversation_id
        FROM public.imap_messages m
        LEFT JOIN public.imap_thread_active_assignments assignment
          ON assignment.message_id = m.id
         AND assignment.account_id = m.account_id
        WHERE m.id = $1
          AND ($2::uuid IS NULL OR m.account_id = $2)
          AND m.deleted_in_provider = false
        `,
        [messageId, accountScope]
      );
      const seed = seedResult.rows[0];
      if (!seed) {
        return toolError(
          "not_found",
          `No message found for id ${messageId}.`,
          "Use a message_id from search_email in this mirror; an id from another email tool never matches. " +
            "Check the account scope. The message may be deleted in the provider."
        );
      }
      if (seed.conversation_id) {
        resolvedConversationId = seed.conversation_id;
        fetched = await fetchThreadRows(client, {
          kind: "conversation",
          conversationId: seed.conversation_id,
          accountId: seed.account_id
        }, maxMessages, cursor, options);
      } else {
        fetched = await fetchThreadRows(client, { kind: "keys", seed }, maxMessages, cursor, options);
      }
      accountIds = [seed.account_id];
    }

    if (fetched.rows.length === 0 && cursor) {
      return toolError(
        "not_found",
        "No messages before cursor.",
        "Read the thread again without cursor and continue from the next_cursor it returns."
      );
    }

    if (fetched.rows.length === 0 && (conversationId || threadId)) {
      const selector = conversationId ? "conversation_id" : "thread_id";
      const value = conversationId ?? threadId;
      return toolError(
        "not_found",
        `No thread found for ${selector} ${value}.`,
        "Check the identifier and account scope. The conversation may have no live messages remaining."
      );
    }

    const accounts = await buildReadAccounts(client, accountIds, metadataProtection);

    const attachments = await loadMessageAttachments(
      client,
      fetched.rows.map((row) => row.id),
      metadataProtection,
      { filesOnly: true }
    );
    const rows = await Promise.all(fetched.rows.map(async (row) => ({
      ...await revealMetadataRecord(
        metadataProtection,
        { kind: "message", accountId: row.account_id, recordId: row.id },
        row,
        METADATA_PROTECTED_FIELDS.message
      ),
      provider_thread_id: row.provider_thread_id,
      attachments: attachments.get(row.id) ?? []
    })));
    const totalCount = fetched.totalCount;
    // SQL already keeps the newest messages; retain a defensive cap for injected
    // test clients and restore no additional database work in production.
    const kept = rows.length > maxMessages ? rows.slice(rows.length - maxMessages) : rows;
    const omitted = Math.max(0, fetched.remainingCount - kept.length);

    const messages = kept.map((row, index) => {
      const message = mapMessageRow(row, {
        // Keep quoted content in the oldest mirrored message when it was not
        // removed by the message cap.
        includeQuoted: includeQuoted || (omitted === 0 && index === 0)
      });
      if (row.inline_count > 0) message.inline_count = row.inline_count;
      if (row.duplicate_message_ids?.length) message.duplicate_message_ids = row.duplicate_message_ids;
      return message;
    });
    // With no older message capped away, the oldest message's References and
    // In-Reply-To name every ancestor the mirror should hold.
    const missingAncestors = omitted === 0 && kept.length > 0 ? countMissingAncestors(kept) : 0;
    const threadOmissions: ReadThreadResult["thread_omissions"] = [];
    if (omitted > 0) threadOmissions.push("older_messages");
    if (missingAncestors > 0) threadOmissions.push("ancestors_not_mirrored");

    // Representative subject + provider handle come from the newest logical delivery.
    // A legacy selector may still discover a unanimous stored conversation id.
    const newest = rows[rows.length - 1];
    const providerThreadId = newest?.provider_thread_id ?? (threadId ?? null);
    if (!resolvedConversationId) {
      const assignedIds = new Set(rows.map((row) => row.conversation_id).filter((id): id is string => Boolean(id)));
      if (assignedIds.size === 1) resolvedConversationId = [...assignedIds][0];
    }
    const subject = newest?.subject ?? null;

    return {
      thread: {
        conversation_id: resolvedConversationId,
        ...(providerThreadId === null ? {} : { provider_thread_id: providerThreadId }),
        subject,
        participants: collectParticipants(rows),
        message_count: totalCount
      },
      messages,
      omitted_message_count: omitted,
      ...(omitted > 0 ? { next_cursor: messages[0].message_id } : {}),
      ...(missingAncestors > 0 ? { missing_ancestor_count: missingAncestors } : {}),
      thread_content_status: threadOmissions.length > 0 ? "partial" : "complete",
      thread_omissions: threadOmissions,
      accounts
    };
  });
}

export function runReadThread(
  pool: PgPool,
  args: unknown,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection,
  options: ReadThreadOptions = {}
): Promise<ReadThreadResult | ReadThreadBatchResult | ReturnType<typeof toolError>> {
  return runReadThreadInternal(pool, args, metadataProtection, options);
}

export const readThreadEntry: ToolEntry = {
  definition: readThreadDefinition,
  handler: (pool, args) => runReadThread(pool, args)
};
