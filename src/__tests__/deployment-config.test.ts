import { access, readFile } from "node:fs/promises";
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

  it("does not keep a competing Render deployment path", async () => {
    await expect(access(resolve(process.cwd(), "render.yaml"))).rejects.toThrow();
    await expect(access(resolve(process.cwd(), "docs/render-supabase.md"))).rejects.toThrow();
  });

  it("keeps Fly.io as the recommended hosted deployment path", async () => {
    const readme = await readFile(resolve(process.cwd(), "README.md"), "utf8");
    const deploymentOptions = await readFile(resolve(process.cwd(), "docs/deployment-options.md"), "utf8");
    const flyGuide = await readFile(resolve(process.cwd(), "docs/fly-supabase.md"), "utf8");

    expect(readme).toContain("Quickstart: Supabase + Fly.io");
    expect(readme).toContain("docs/fly-supabase.md");
    expect(deploymentOptions).toContain("Use Fly.io as the hosted path");
    expect(flyGuide).toContain("This is the recommended hosted setup for SupaMail.");
    expect(readme).not.toContain("render.yaml");
    expect(deploymentOptions).not.toContain("Render");
  });

  it("documents single-machine Fly launch commands for the starter worker/API", async () => {
    const workerToml = await readFile(resolve(process.cwd(), "fly.worker.toml.example"), "utf8");
    const apiToml = await readFile(resolve(process.cwd(), "fly.api.toml.example"), "utf8");

    expect(workerToml).toContain("fly launch --no-deploy --no-public-ips --ha=false");
    expect(workerToml).toContain("fly deploy --ha=false");
    expect(apiToml).toContain("fly launch --config fly.api.toml --no-deploy --ha=false");
    expect(apiToml).toContain("fly deploy --config fly.api.toml --ha=false");
  });
});
