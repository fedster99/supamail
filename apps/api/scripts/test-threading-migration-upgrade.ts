import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

interface Manifest {
  migrations: Array<{ id: string; file: string }>;
}

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = resolve(here, "../supabase/migrations/public");
const manifest = JSON.parse(
  await readFile(resolve(migrationDir, "manifest.json"), "utf8")
) as Manifest;
const threadingIndex = manifest.migrations.findIndex((migration) => migration.id === "0014_conversation_threading");
if (threadingIndex < 1) throw new Error("0014_conversation_threading must follow the legacy schema");
const fingerprintClosureIndex = manifest.migrations.findIndex(
  (migration) => migration.id === "0020_threading_fingerprint_closure"
);
if (fingerprintClosureIndex <= threadingIndex) {
  throw new Error("0020_threading_fingerprint_closure must follow the threading schema");
}
const closureEdgesIndex = manifest.migrations.findIndex(
  (migration) => migration.id === "0026_threading_closure_edges"
);
if (closureEdgesIndex <= fingerprintClosureIndex) {
  throw new Error("0026_threading_closure_edges must follow fingerprint closure");
}

const databaseName = `sm_thread_upgrade_${process.pid}_${randomUUID().slice(0, 8)}`.replace(/-/g, "_");
const quotedDatabaseName = `"${databaseName}"`;
const admin = new Client({ connectionString: databaseUrl });
const targetUrl = new URL(databaseUrl);
targetUrl.pathname = `/${databaseName}`;
const target = new Client({ connectionString: targetUrl.toString() });

async function applyFiles(files: Array<{ file: string }>): Promise<void> {
  for (const migration of files) {
    await target.query(await readFile(resolve(migrationDir, migration.file), "utf8"));
  }
}

await admin.connect();
try {
  await admin.query(`CREATE DATABASE ${quotedDatabaseName} TEMPLATE template0`);
  await target.connect();
  try {
    await applyFiles(manifest.migrations.slice(0, threadingIndex));
    const account = await target.query<{ id: string }>(
      `INSERT INTO public.imap_accounts (
         email_address, host, port, username, encrypted_password
       ) VALUES ('populated-upgrade@example.test', 'imap.example.test', 993,
                 'populated-upgrade@example.test', decode('00', 'hex'))
       RETURNING id`
    );
    await target.query(
      `INSERT INTO public.imap_messages (
         account_id, folder_path, uidvalidity, uid, internal_date,
         rfc_message_id, message_id_normalized, subject, headers_json,
         window_status, size_bytes
       )
       SELECT $1, 'INBOX', 101, value,
              timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second',
              '<legacy-' || value || '@example.test>',
              'legacy-' || value || '@example.test',
              'Legacy message ' || value,
              jsonb_build_object('message-id', '<legacy-' || value || '@example.test>'),
              'IN_WINDOW', 0
       FROM generate_series(1, 5000) AS value`,
      [account.rows[0].id]
    );
    await target.query(
      `INSERT INTO public.imap_message_bodies (
         message_id, raw_mime, raw_bytes, raw_truncated,
         body_text, headers_json
       )
       SELECT id, NULL, 0, false, 'legacy parsed-only body', '{}'::jsonb
       FROM public.imap_messages
       WHERE account_id = $1`,
      [account.rows[0].id]
    );

    const startedAt = performance.now();
    const threadingMigration = manifest.migrations[threadingIndex];
    await applyFiles([threadingMigration]);
    await applyFiles([threadingMigration]);
    await applyFiles(manifest.migrations.slice(threadingIndex + 1, fingerprintClosureIndex));

    const run = await target.query<{ id: string }>(
      `INSERT INTO public.imap_thread_runs (
         account_id, algorithm_version, mode, status, stage, requested_by, reason
       ) VALUES ($1, 2, 'initial', 'building', 'strong', 'migration-test', 'pre-0020 fixture')
       RETURNING id`,
      [account.rows[0].id]
    );
    await target.query(
      `INSERT INTO public.imap_thread_assignments (
         run_id, message_id, account_id, delivery_key, conversation_id,
         assignment_method, confidence, algorithm_version, input_hash, generation
       )
       SELECT $1, id, account_id, $2, $3,
              'standalone', 'high', 2, $4, 1
       FROM public.imap_messages
       WHERE account_id = $5
       ORDER BY id
       LIMIT 1`,
      [
        run.rows[0].id,
        "a".repeat(64),
        `thread_${"b".repeat(32)}`,
        "c".repeat(64),
        account.rows[0].id
      ]
    );
    const fingerprintClosureMigration = manifest.migrations[fingerprintClosureIndex];
    await applyFiles([fingerprintClosureMigration]);
    await applyFiles([fingerprintClosureMigration]);
    const closureEdgesMigration = manifest.migrations[closureEdgesIndex];
    await applyFiles([closureEdgesMigration]);
    await applyFiles([closureEdgesMigration]);
    const elapsedMs = Math.round(performance.now() - startedAt);

    const result = await target.query<{
      messages: string;
      bodies: string;
      states: string;
      runs: string;
      provider_values: string;
      body_hashes: string;
      invalid_constraints: string;
      assignments: string;
      empty_fingerprint_arrays: string;
      fingerprint_constraint_not_valid: string;
      closure_edges: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM public.imap_messages WHERE account_id = $1) AS messages,
         (SELECT count(*)::text FROM public.imap_message_bodies body
          JOIN public.imap_messages message ON message.id = body.message_id
          WHERE message.account_id = $1) AS bodies,
         (SELECT count(*)::text FROM public.imap_thread_state WHERE account_id = $1) AS states,
         (SELECT count(*)::text FROM public.imap_thread_runs WHERE account_id = $1) AS runs,
         (SELECT count(*)::text FROM public.imap_messages
          WHERE account_id = $1 AND (
            provider_message_id IS NOT NULL OR provider_message_id_namespace IS NOT NULL
            OR provider_thread_id_namespace IS NOT NULL
          )) AS provider_values,
         (SELECT count(*)::text FROM public.imap_message_bodies body
          JOIN public.imap_messages message ON message.id = body.message_id
          WHERE message.account_id = $1 AND body.raw_mime_sha256 IS NOT NULL) AS body_hashes,
         (SELECT count(*)::text FROM pg_constraint
          WHERE conname IN (
            'imap_messages_provider_message_identity_check',
            'imap_messages_provider_thread_namespace_check',
            'imap_message_bodies_raw_mime_sha256_check'
          ) AND convalidated) AS invalid_constraints,
         (SELECT count(*)::text FROM public.imap_thread_assignments
          WHERE run_id = $2) AS assignments,
         (SELECT count(*)::text FROM public.imap_thread_assignments
          WHERE run_id = $2 AND cardinality(delivery_fingerprint_hashes) = 0)
          AS empty_fingerprint_arrays,
         (SELECT count(*)::text FROM pg_constraint
          WHERE conrelid = 'public.imap_thread_assignments'::regclass
            AND conname = 'imap_thread_assignments_delivery_fingerprint_hashes_check'
            AND NOT convalidated) AS fingerprint_constraint_not_valid,
         (SELECT count(*)::text FROM public.imap_thread_closure_edges
          WHERE run_id = $2) AS closure_edges`,
      [account.rows[0].id, run.rows[0].id]
    );
    const observed = result.rows[0];
    const expected = {
      messages: "5000",
      bodies: "5000",
      states: "0",
      runs: "1",
      provider_values: "0",
      body_hashes: "0",
      invalid_constraints: "0",
      assignments: "1",
      empty_fingerprint_arrays: "1",
      fingerprint_constraint_not_valid: "1",
      closure_edges: "2"
    };
    if (JSON.stringify(observed) !== JSON.stringify(expected)) {
      throw new Error(`Populated threading migration changed legacy data: ${JSON.stringify(observed)}`);
    }
    console.log(JSON.stringify({
      event: "threading.populated_migration.passed",
      rows: 5000,
      elapsedMs
    }));
  } finally {
    await target.end().catch(() => undefined);
  }
} finally {
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [databaseName]
  ).catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabaseName}`).catch(() => undefined);
  await admin.end().catch(() => undefined);
}
