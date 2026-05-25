import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(apiRoot, "../..");

describe("deployment configs", () => {
  it("pins every runtime surface to Node 24", async () => {
    const rootPackage = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")) as {
      engines: { node: string };
    };
    const apiPackage = JSON.parse(await readFile(resolve(apiRoot, "package.json"), "utf8")) as {
      engines: { node: string };
    };
    const webPackage = JSON.parse(await readFile(resolve(repoRoot, "apps/web/package.json"), "utf8")) as {
      engines: { node: string };
    };
    const dockerfile = await readFile(resolve(apiRoot, "Dockerfile"), "utf8");
    const ci = await readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const nodeVersion = await readFile(resolve(repoRoot, ".node-version"), "utf8");
    const nvmrc = await readFile(resolve(repoRoot, ".nvmrc"), "utf8");
    const workerToml = await readFile(resolve(apiRoot, "fly.worker.toml.example"), "utf8");
    const apiToml = await readFile(resolve(apiRoot, "fly.api.toml.example"), "utf8");

    expect(rootPackage.engines.node).toBe("24.x");
    expect(apiPackage.engines.node).toBe("24.x");
    expect(webPackage.engines.node).toBe("24.x");
    expect(dockerfile).toContain("FROM node:24-slim AS base");
    expect(dockerfile).toContain("FROM node:24-slim AS runner");
    expect(ci).toContain("node-version: 24");
    expect(ci).toContain("actions/checkout@v6");
    expect(ci).toContain("pnpm/action-setup@v6");
    expect(ci).toContain("actions/setup-node@v6");
    expect(nodeVersion.trim()).toBe("24");
    expect(nvmrc.trim()).toBe("24");
    expect(workerToml).toContain("node:24-slim");
    expect(apiToml).toContain("node:24-slim");
  });

  it("keeps the default Fly worker profile inside the lowest-cost 256 MB machine", async () => {
    const toml = await readFile(resolve(apiRoot, "fly.worker.toml.example"), "utf8");

    expect(toml).toContain('dockerfile = "apps/api/Dockerfile"');
    expect(toml).toContain('memory = "256mb"');
    expect(toml).toContain('NODE_OPTIONS = "--max-old-space-size=160"');
    expect(toml).toContain('BODY_RAW_MAX_BYTES = "8388608"');
    expect(toml).toContain('BODY_BACKFILL_BATCH_SIZE = "3"');
    expect(toml).toContain('INITIAL_SYNC_BATCH_SIZE = "25"');
    expect(toml).toContain('INCREMENTAL_SYNC_BATCH_SIZE = "25"');
  });

  it("does not keep a competing Render deployment path", async () => {
    await expect(access(resolve(repoRoot, "render.yaml"))).rejects.toThrow();
    await expect(access(resolve(repoRoot, "docs/render-supabase.md"))).rejects.toThrow();
    await expect(access(resolve(apiRoot, "render.yaml"))).rejects.toThrow();
  });

  it("keeps Fly.io as the recommended hosted deployment path", async () => {
    const readme = await readFile(resolve(repoRoot, "README.md"), "utf8");
    const deploymentOptions = await readFile(resolve(repoRoot, "docs/deployment-options.md"), "utf8");
    const flyGuide = await readFile(resolve(repoRoot, "docs/fly-supabase.md"), "utf8");
    const hostedBoundary = await readFile(resolve(repoRoot, "docs/hosted-product-boundary.md"), "utf8");

    expect(readme).toContain("Quickstart: Supabase + Fly.io");
    expect(readme).toContain("docs/fly-supabase.md");
    expect(readme).toContain("docs/hosted-product-boundary.md");
    expect(deploymentOptions).toContain("Use Fly.io as the hosted path");
    expect(flyGuide).toContain("This is the recommended hosted setup for SupaMail.");
    expect(hostedBoundary).toContain("The public repo intentionally does not include the hosted SaaS wrapper");
    expect(readme).not.toContain("render.yaml");
    expect(deploymentOptions).not.toContain("Render");
  });

  it("documents single-machine Fly launch commands for the starter worker/API", async () => {
    const workerToml = await readFile(resolve(apiRoot, "fly.worker.toml.example"), "utf8");
    const apiToml = await readFile(resolve(apiRoot, "fly.api.toml.example"), "utf8");

    expect(workerToml).toContain("fly launch --config apps/api/fly.worker.toml --no-deploy --no-db --no-public-ips --ha=false");
    expect(workerToml).toContain("fly deploy --config apps/api/fly.worker.toml --ha=false");
    expect(apiToml).toContain("fly launch --config apps/api/fly.api.toml --no-deploy --no-db --ha=false");
    expect(apiToml).toContain("fly deploy --config apps/api/fly.api.toml --ha=false");
  });

  it("publishes immutable public core images only after CI passes", async () => {
    const workflow = await readFile(resolve(repoRoot, ".github/workflows/publish-core-image.yml"), "utf8");

    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("workflows:");
    expect(workflow).toContain("- CI");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
    expect(workflow).toContain("ghcr.io/${{ github.repository_owner }}/supamail-api:sha-$core_sha");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toContain("docker/login-action@v4");
    expect(workflow).toContain("docker build -f apps/api/Dockerfile");
    expect(workflow).toContain("SUPAMAIL_RUNTIME_CHECK=1");
    expect(workflow).toContain("docker push");
  });
});
