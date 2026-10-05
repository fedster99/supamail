import { getConfig, type AppConfig } from "../../config.js";
import type { BodyStore } from "../../body-store.js";
import { applyPublicMigrations, getPool, type PgPool } from "../../db.js";
import { MirrorRepository } from "../../repository.js";
import { FixtureImapClient, type FixtureFolder, makeTextMessage } from "../../smoke/fixture-imap.js";
import { MirrorEngine } from "../../sync-engine.js";
import type { MirrorImapClient } from "../../imap-client.js";
import type { MirrorHooks } from "../../types.js";

export interface IntegrationHarness {
  pool: PgPool;
  config: AppConfig;
  repository: MirrorRepository;
  account: { id: string };
  buildEngine(opts: {
    folders: FixtureFolder[];
    overrides?: Partial<AppConfig>;
    clientFactory?: (
      account: unknown,
      options?: { signal?: AbortSignal }
    ) => Promise<MirrorImapClient>;
    hooks?: MirrorHooks;
    bodyStore?: BodyStore;
  }): MirrorEngine;
}

export async function setupIntegration(suite: string, overrides: Partial<AppConfig> = {}): Promise<IntegrationHarness> {
  const pool = getPool();
  if (process.env.SKIP_TEST_MIGRATION !== "1") {
    await applyPublicMigrations(pool);
  }
  const config: AppConfig = {
    ...getConfig(),
    BODY_FETCH_POLICY: "lazy",
    BODY_BACKFILL_BATCH_SIZE: 5,
    INITIAL_SYNC_BATCH_SIZE: 2,
    INCREMENTAL_SYNC_BATCH_SIZE: 5,
    IMAP_ALLOW_PRIVATE_HOSTS: true,
    ...overrides
  };
  const email = `integration-${suite}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const repository = new MirrorRepository(pool, config);
  const account = await repository.createAccount({
    emailAddress: email,
    host: "fake.imap.local",
    port: 993,
    secure: true,
    username: email,
    password: "not-used",
    providerProfile: "generic-imap",
    bodyFetchPolicy: "lazy"
  });

  return {
    pool,
    config,
    repository,
    account: { id: account.id },
    buildEngine({ folders, overrides: engineOverrides = {}, clientFactory, hooks, bodyStore }) {
      return new MirrorEngine({
        pool,
        config: { ...config, ...engineOverrides },
        repository,
        bodyStore,
        hooks,
        clientFactory:
          clientFactory ?? (async () => new FixtureImapClient(folders))
      });
    }
  };
}

export async function teardownIntegration(pool: PgPool, accountId: string): Promise<void> {
  await pool.query("DELETE FROM public.imap_accounts WHERE id = $1", [accountId]);
}

/** Folders whose trigger-kept counts (migration 0028) differ from a fresh count. */
export async function folderCountDrift(
  pool: PgPool,
  accountIds: string[]
): Promise<Array<{ account_id: string; folder_path: string }>> {
  const result = await pool.query<{ account_id: string; folder_path: string }>(
    `
    WITH live AS (
      SELECT account_id, folder_path, count(*)::int AS messages,
             count(*) FILTER (
               WHERE NOT (coalesce(flags, '{}'::text[]) @> ARRAY['\\Seen']::text[])
             )::int AS unread
      FROM public.imap_messages
      WHERE account_id = ANY($1::uuid[]) AND deleted_in_provider = false
      GROUP BY account_id, folder_path
    ), stored AS (
      SELECT account_id, folder_path, message_count AS messages, unread_count AS unread
      FROM public.imap_folder_message_counts
      WHERE account_id = ANY($1::uuid[])
    )
    SELECT account_id, folder_path
    FROM live FULL JOIN stored USING (account_id, folder_path)
    WHERE (coalesce(live.messages, 0), coalesce(live.unread, 0))
      IS DISTINCT FROM (coalesce(stored.messages, 0), coalesce(stored.unread, 0))
    `,
    [accountIds]
  );
  return result.rows;
}

export async function dueAllFolders(pool: PgPool, accountId: string): Promise<void> {
  await pool.query(
    `UPDATE public.imap_folders SET next_sync_due_at = now() - interval '1 second' WHERE account_id = $1`,
    [accountId]
  );
}

export async function backdateMissingSince(
  pool: PgPool,
  accountId: string,
  folderPath: string,
  interval: string
): Promise<void> {
  await pool.query(
    `UPDATE public.imap_folders SET missing_since = now() - $3::interval
     WHERE account_id = $1 AND path = $2`,
    [accountId, folderPath, interval]
  );
}

export async function forceFolderDiscovery(pool: PgPool, accountId: string): Promise<void> {
  await pool.query(
    `UPDATE public.imap_accounts SET next_folder_discovery_at = now() - interval '1 second' WHERE id = $1`,
    [accountId]
  );
}

export function buildInboxAndSentFolders(): FixtureFolder[] {
  return [
    {
      path: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      uidValidity: 11_001,
      messages: [
        makeTextMessage({ uid: 101, subject: "a", from: "a@x.test", to: "u@x.test", body: "a" }),
        makeTextMessage({ uid: 102, subject: "b", from: "b@x.test", to: "u@x.test", body: "b" }),
        makeTextMessage({ uid: 103, subject: "c", from: "c@x.test", to: "u@x.test", body: "c" }),
        makeTextMessage({ uid: 104, subject: "d", from: "d@x.test", to: "u@x.test", body: "d" }),
        makeTextMessage({ uid: 105, subject: "e", from: "e@x.test", to: "u@x.test", body: "e" })
      ]
    },
    {
      path: "Sent",
      delimiter: "/",
      specialUse: "\\Sent",
      uidValidity: 22_002,
      messages: [
        makeTextMessage({ uid: 201, subject: "y", from: "u@x.test", to: "a@x.test", body: "y" })
      ]
    }
  ];
}
