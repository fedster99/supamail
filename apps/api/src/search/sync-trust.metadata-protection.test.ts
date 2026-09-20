import assert from "node:assert/strict";
import { test } from "vitest";
import type { MetadataProtectionAdapter } from "../metadata-protection.js";
import { buildSyncTrust } from "./sync-trust.js";

test("sync trust bounds the progress lookup to each requested Mailbox Account", async () => {
  const accountIds = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
  let sql = "";
  const db = { query: async (text: string, values: unknown[]) => {
    sql = text;
    assert.deepEqual(values, [accountIds]);
    return { rows: [] };
  } };
  await buildSyncTrust(db as unknown as Parameters<typeof buildSyncTrust>[0], accountIds);
  assert.match(sql, /LEFT JOIN LATERAL\s*\([\s\S]*FROM public\.imap_account_progress progress\s+WHERE progress\.account_id = a\.id\s+LIMIT 1\s*\) p ON true/);
});

test("bulk and unfiltered sync trust retain the set-based progress lookup", async () => {
  for (const scope of [null, [], ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]]) {
    let sql = "";
    const db = { query: async (text: string) => { sql = text; return { rows: [] }; } };
    await buildSyncTrust(db as unknown as Parameters<typeof buildSyncTrust>[0], scope);
    assert.match(sql, /LEFT JOIN public\.imap_account_progress p ON p\.account_id = a\.id/);
    assert.doesNotMatch(sql, /LATERAL/);
  }
});

test("sync trust reveals the Mailbox Account email through the injected adapter", async () => {
  const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const envelope = Buffer.from("ciphertext");
  const adapter: MetadataProtectionAdapter = {
    storageMode: "protected",
    async protect() {
      throw new Error("not used");
    },
    async reveal(context, stored) {
      assert.deepEqual(context, {
        kind: "account",
        accountId,
        recordId: accountId
      });
      assert.equal(stored.protectedMetadata, envelope);
      return { ...stored.values, email_address: "owner@example.test" };
    }
  };
  const db = {
    query: async () => ({
      rows: [{
        account_id: accountId,
        email_address: "token@protected.invalid",
        sync_state: "HEALTHY",
        sync_state_reason: null,
        last_sync_finished_at: new Date("2026-07-31T10:00:00Z"),
        currently_syncing: false,
        initial_sync_in_progress: false,
        historical_backfill_in_progress: false,
        live_headers_complete_pct: 100,
        live_bodies_complete_pct: 100,
        historical_bodies_complete_pct: 100,
        protected_metadata: envelope,
        protected_metadata_version: 1,
        protected_metadata_key_version: 1,
        protected_metadata_tokens: { email_address: "token" }
      }]
    })
  };

  const trust = await buildSyncTrust(
    db as unknown as Parameters<typeof buildSyncTrust>[0],
    [accountId],
    adapter
  );
  assert.equal(trust.accounts[0]?.account_email, "owner@example.test");
});
