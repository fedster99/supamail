import { z } from "zod";
import type { PgClient, PgPool } from "../../db.js";
import type { SyncTrust } from "../../search/index.js";
import { buildSyncTrust } from "../../search/index.js";
import { threadMembershipClause, threadSeedKeys, type ThreadSeedRow } from "../../thread-walk.js";
import type { MessageAttachment, MessageDetail, MessageDetailRow, ToolDefinition, ToolEntry } from "../shared.js";
import { loadMessageAttachments, mapMessageRow, toolError, withReadOnlyTx } from "../shared.js";
import {
  METADATA_PROTECTED_FIELDS,
  plaintextMetadataProtection,
  revealMetadataRecord,
  type MetadataProtectionAdapter,
  type ProtectedMetadataColumns
} from "../../metadata-protection.js";

/**
 * `read_thread` — reassemble a conversation from the mirror and return every
 * message in it, oldest first, with cleaned bodies and a flat attachments index.
 *
 * Seed by a `message_id` (any message in the thread), a durable
 * `conversation_id`, or the legacy provider `thread_id`. A message with a stored
 * assignment resolves through the complete account-scoped conversation and
 * mirrored delivery copies collapse to one deterministic representative. The
 * old one-hop References walk remains only as a compatibility fallback for
 * messages that have not been assigned yet.
 *
 * Read-only by construction (SELECTs inside {@link withReadOnlyTx}); never sends,
 * moves, or mutates mail.
 */

const DEFAULT_MAX_MESSAGES = 20;
const MAX_MESSAGES_CEILING = 100;

/**
 * Collapse physical mailbox occurrences only when we have delivery-identity
 * evidence. An active threading assignment is authoritative. During the
 * pre-activation compatibility window we can still safely collapse a provider
 * message id, or an RFC Message-ID paired with the exact complete raw-MIME
 * digest. Everything else remains a distinct physical row rather than risking
 * a false merge.
 *
 * The fallback keys are fixed-size hashes so sorting a hostile provider value
 * cannot create an unbounded PostgreSQL sort key.
 */
const DELIVERY_REPRESENTATIVE_KEY = `coalesce(
  ta.delivery_key,
  CASE
    WHEN nullif(m.provider_message_id_namespace, '') IS NOT NULL
      AND nullif(m.provider_message_id, '') IS NOT NULL
      THEN 'provider:' || encode(extensions.digest(
        m.provider_message_id_namespace || chr(31) || m.provider_message_id,
        'sha256'
      ), 'hex')
    WHEN nullif(m.message_id_normalized, '') IS NOT NULL
      AND b.raw_mime_sha256 IS NOT NULL
      THEN 'rfc-body:' || encode(extensions.digest(
        m.message_id_normalized || chr(31) || b.raw_mime_sha256,
        'sha256'
      ), 'hex')
    ELSE 'physical:' || m.id::text
  END
)`;

/** The fields each thread message selects: the {@link MessageDetailRow} columns
 * a tool needs to call {@link mapMessageRow}, plus `internal_date` for ORDER BY.
 * Attachments use the shared {@link ATTACHMENTS_AGG} fragment (alias `m`). */
const THREAD_SELECT = `
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
  m.window_status,
  m.internal_date,
  m.protected_metadata,
  m.protected_metadata_version,
  m.protected_metadata_key_version,
  m.protected_metadata_tokens,
  b.body_text,
  b.body_plain,
  b.selected_text_part,
  stats.total_count AS thread_total_count,
  stats.participants AS thread_participants
`;

type ThreadRow = MessageDetailRow & ProtectedMetadataColumns & {
  conversation_id: string | null;
  thread_total_count: number | string | null;
  thread_participants: string[] | null;
};

interface FetchedThread {
  rows: ThreadRow[];
  totalCount: number;
  participants: string[];
}

/** The seed message's threading fields. Aliased to the shared {@link ThreadSeedRow}
 * (CC-3) so read and write resolve the same seed shape. */
type SeedRow = ThreadSeedRow & { conversation_id: string | null };

export interface ReadThreadArgs {
  message_id?: string;
  conversation_id?: string;
  thread_id?: string;
  account?: string;
  include_quoted?: boolean;
  max_messages?: number;
}

/**
 * Strict input schema for `read_thread` (matches the list_folders validate
 * pattern). Only `account` is a UUID; provider and durable conversation ids are
 * opaque text, so they are NOT uuid-validated. The selector requirement is
 * enforced separately so it returns a clearer hint.
 */
export const readThreadRequestSchema = z
  .object({
    message_id: z.string().optional(),
    conversation_id: z.string().optional(),
    thread_id: z.string().optional(),
    account: z.string().uuid().optional(),
    include_quoted: z.boolean().optional(),
    max_messages: z.number().optional()
  })
  .strict();

export interface ReadThreadResult {
  thread: {
    conversation_id: string | null;
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
    "message_id (any message in the thread, used as the seed), a durable conversation_id, " +
    "or a legacy provider thread_id. Direct conversation/thread selectors require account. " +
    "Returns the thread's messages oldest-first with cleaned plain-text " +
    "bodies (quoted reply tails and signatures stripped unless include_quoted=true), the " +
    "distinct participants, a flat attachments_index, and a sync_trust block. Threading is a " +
    "ONE-HOP references walk (seed's provider_thread_id + its own id + strict, " +
    "case-preserving bracketed RFC Message-ID tokens) — it catches direct parents, children, and " +
    "provider-threaded siblings only when the seed has no stored assignment. Capped to " +
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
    anyOf: [
      { required: ["message_id"] },
      { required: ["conversation_id", "account"] },
      { required: ["thread_id", "account"] }
    ],
    properties: {
      message_id: {
        type: "string",
        description: "A message UUID to seed the thread from (any message in the conversation)."
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

/**
 * Count the full logical conversation and collect its participants, but hydrate
 * bodies/attachments for only the newest requested deliveries. The final SELECT
 * restores oldest-first order for the public response.
 */
function boundedThreadCtes(limitParameter: string): string {
  return `,
    thread_stats AS (
      SELECT
        (SELECT count(*)::int FROM delivery_representatives) AS total_count,
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
      SELECT representative.id
      FROM delivery_representatives representative
      JOIN public.imap_messages m ON m.id = representative.id
      ORDER BY m.internal_date DESC, m.id DESC
      LIMIT ${limitParameter}
    )`;
}

function summarizeFetchedRows(rows: ThreadRow[]): FetchedThread {
  const totalCount = Number(rows[0]?.thread_total_count ?? rows.length);
  return {
    rows,
    totalCount: Number.isFinite(totalCount) ? totalCount : rows.length,
    participants: rows[0]?.thread_participants ?? collectParticipants(rows)
  };
}

async function fetchThreadRows(
  client: PgClient,
  selector:
    | { kind: "conversation"; conversationId: string; accountId: string }
    | { kind: "provider-thread"; threadId: string; accountId: string }
    | { kind: "keys"; seed: SeedRow },
  maxMessages: number
): Promise<FetchedThread> {
  if (selector.kind === "conversation") {
    const result = await client.query<ThreadRow>(
      `
      WITH delivery_representatives AS (
        SELECT DISTINCT ON (assignment.delivery_key)
          m.id
        FROM public.imap_thread_active_assignments assignment
        JOIN public.imap_messages m
          ON m.id = assignment.message_id
         AND m.account_id = assignment.account_id
        WHERE assignment.account_id = $1
          AND assignment.conversation_id = $2
          AND m.deleted_in_provider = false
        ORDER BY
          assignment.delivery_key,
          (m.body_fetched_at IS NOT NULL) DESC,
          m.folder_path ASC,
          m.id ASC
      )${boundedThreadCtes("$3")}
      SELECT ${THREAD_SELECT}
      FROM limited_representatives representative
      JOIN public.imap_messages m ON m.id = representative.id
      LEFT JOIN public.imap_thread_active_assignments ta
        ON ta.message_id = m.id
       AND ta.account_id = m.account_id
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
      CROSS JOIN thread_stats stats
      ORDER BY m.internal_date ASC, m.id ASC
      `,
      [selector.accountId, selector.conversationId, maxMessages]
    );
    return summarizeFetchedRows(result.rows);
  }

  if (selector.kind === "provider-thread") {
    const result = await client.query<ThreadRow>(
      `
      WITH delivery_representatives AS (
        SELECT DISTINCT ON (m.account_id, ${DELIVERY_REPRESENTATIVE_KEY})
          m.id
        FROM public.imap_messages m
        LEFT JOIN public.imap_thread_active_assignments ta
          ON ta.message_id = m.id
         AND ta.account_id = m.account_id
        LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
        WHERE m.provider_thread_id = $1
          AND m.account_id = $2
          AND m.deleted_in_provider = false
        ORDER BY
          m.account_id,
          ${DELIVERY_REPRESENTATIVE_KEY},
          (m.body_fetched_at IS NOT NULL) DESC,
          m.folder_path ASC,
          m.id ASC
      )${boundedThreadCtes("$3")}
      SELECT ${THREAD_SELECT}
      FROM limited_representatives representative
      JOIN public.imap_messages m ON m.id = representative.id
      LEFT JOIN public.imap_thread_active_assignments ta
        ON ta.message_id = m.id
       AND ta.account_id = m.account_id
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
      CROSS JOIN thread_stats stats
      ORDER BY m.internal_date ASC, m.id ASC
      `,
      [selector.threadId, selector.accountId, maxMessages]
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
    delivery_representatives AS (
      SELECT DISTINCT ON (m.account_id, ${DELIVERY_REPRESENTATIVE_KEY})
        m.id
      FROM legacy_candidates candidate
      JOIN public.imap_messages m ON m.id = candidate.id
      LEFT JOIN public.imap_thread_active_assignments ta
        ON ta.message_id = m.id
       AND ta.account_id = m.account_id
      LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
      ORDER BY
        m.account_id,
        ${DELIVERY_REPRESENTATIVE_KEY},
        (m.body_fetched_at IS NOT NULL) DESC,
        m.folder_path ASC,
        m.id ASC
    )${boundedThreadCtes("$5")}
    SELECT ${THREAD_SELECT}
    FROM limited_representatives representative
    JOIN public.imap_messages m ON m.id = representative.id
    LEFT JOIN public.imap_thread_active_assignments ta
      ON ta.message_id = m.id
     AND ta.account_id = m.account_id
    LEFT JOIN public.imap_message_bodies b ON b.message_id = m.id
    CROSS JOIN thread_stats stats
    ORDER BY m.internal_date ASC, m.id ASC
    `,
    [seed.account_id, seed.provider_thread_id, seed.id, keys, maxMessages]
  );
  return summarizeFetchedRows(result.rows);
}

export async function runReadThread(
  pool: PgPool,
  args: unknown,
  metadataProtection: MetadataProtectionAdapter = plaintextMetadataProtection
): Promise<ReadThreadResult | ReturnType<typeof toolError>> {
  let input: ReadThreadArgs;
  try {
    input = readThreadRequestSchema.parse(args ?? {});
  } catch (error) {
    return toolError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid arguments.",
      "Pass message_id, or pass conversation_id/thread_id together with the account UUID."
    );
  }

  const messageId = typeof input.message_id === "string" ? input.message_id : undefined;
  const conversationId = typeof input.conversation_id === "string" ? input.conversation_id : undefined;
  const threadId = typeof input.thread_id === "string" ? input.thread_id : undefined;

  if (!messageId && !conversationId && !threadId) {
    return toolError(
      "invalid_input",
      "read_thread requires message_id, conversation_id, or thread_id.",
      "Pass message_id, or pass conversation_id/thread_id together with account."
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
  // Number.isFinite guards NaN/Infinity so the newest-keeping cap is never
  // silently disabled; non-finite falls back to the default.
  const requestedMax = Number.isFinite(input.max_messages as number) ? (input.max_messages as number) : DEFAULT_MAX_MESSAGES;
  const maxMessages = Math.max(1, Math.min(MAX_MESSAGES_CEILING, Math.floor(requestedMax)));

  return withReadOnlyTx(pool, async (client) => {
    let fetched: FetchedThread;
    let accountIds: string[] | null;

    let resolvedConversationId: string | null = conversationId ?? null;

    if (conversationId) {
      fetched = await fetchThreadRows(client, {
        kind: "conversation",
        conversationId,
        accountId: accountScope!
      }, maxMessages);
      accountIds = [accountScope!];
    } else if (threadId) {
      fetched = await fetchThreadRows(client, {
        kind: "provider-thread",
        threadId,
        accountId: accountScope!
      }, maxMessages);
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
          "Check the message_id (a UUID from search_email) or scope account. The message may be deleted in the provider."
        );
      }
      if (seed.conversation_id) {
        resolvedConversationId = seed.conversation_id;
        fetched = await fetchThreadRows(client, {
          kind: "conversation",
          conversationId: seed.conversation_id,
          accountId: seed.account_id
        }, maxMessages);
      } else {
        fetched = await fetchThreadRows(client, { kind: "keys", seed }, maxMessages);
      }
      accountIds = [seed.account_id];
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

    // sync_trust computed inside the open tx (buildSyncTrust) to avoid a second connection; syncTrustFor is the standalone equivalent.
    const syncTrust = await buildSyncTrust(client, accountIds, metadataProtection);

    const attachments = await loadMessageAttachments(
      client,
      fetched.rows.map((row) => row.id),
      metadataProtection
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
    const omitted = Math.max(0, totalCount - kept.length);

    const messages = kept.map((row) => mapMessageRow(row, { includeQuoted }));
    const attachmentsIndex = messages.flatMap((message) =>
      message.attachments.map((att) => ({ message_id: message.message_id, ...att }))
    );

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
