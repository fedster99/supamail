import assert from "node:assert/strict";
import { test } from "vitest";
import type { MetadataProtectionAdapter } from "../metadata-protection.js";
import { buildSyncTrust } from "./sync-trust.js";

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
