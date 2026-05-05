import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("deployment configs", () => {
  it("keeps the default Fly worker profile inside the lowest-cost 256 MB machine", async () => {
    const toml = await readFile(resolve(process.cwd(), "fly.worker.toml.example"), "utf8");

    expect(toml).toContain('memory = "256mb"');
    expect(toml).toContain('NODE_OPTIONS = "--max-old-space-size=160"');
    expect(toml).toContain('BODY_RAW_MAX_BYTES = "8388608"');
    expect(toml).toContain('BODY_BACKFILL_BATCH_SIZE = "3"');
    expect(toml).toContain('INITIAL_SYNC_BATCH_SIZE = "25"');
    expect(toml).toContain('INCREMENTAL_SYNC_BATCH_SIZE = "25"');
  });

  it("uses SupaMail service names in Render config", async () => {
    const yaml = await readFile(resolve(process.cwd(), "render.yaml"), "utf8");

    expect(yaml).toContain("name: supamail-worker");
    expect(yaml).toContain("name: supamail-api");
    expect(yaml).not.toContain("imap-to-supabase");
  });
});
