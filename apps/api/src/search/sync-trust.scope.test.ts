import { expect, test } from "vitest";
import { buildSyncTrust } from "./sync-trust.js";

const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test.each([
  { ids: [first], scope: first },
  { ids: [first, second], scope: null },
  { ids: [first, first], scope: null },
  { ids: [], scope: null },
  { ids: null, scope: null }
])("keeps the requested set and directly scopes singleton progress: $ids", async ({ ids, scope }) => {
  let observed: { sql: string; values: unknown[] } | undefined;
  const db = {
    async query(sql: string, values: unknown[]) {
      observed = { sql, values };
      return { rows: [] };
    }
  };
  const result = await buildSyncTrust(db as unknown as Parameters<typeof buildSyncTrust>[0], ids);
  expect(observed?.values).toEqual([ids, scope]);
  expect(observed?.sql).toContain("AND ($2::uuid IS NULL OR p.account_id = $2::uuid)");
  expect(result.accounts).toEqual([]);
  expect(result.fully_synced).toBe(false);
});
