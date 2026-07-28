import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { startApiServer } from "../api.js";
import type { AppConfig } from "../config.js";
import type { PgPool } from "../db.js";
import type { MirrorRepository } from "../repository.js";
import type { MirrorEngine } from "../sync-engine.js";

describe("API Node server adapter", () => {
  it("serves a real HTTP request and closes cleanly", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = startApiServer({
      config: { PORT: 0, API_TOKEN: "api-token" } as AppConfig,
      pool: {} as PgPool,
      repository: {} as MirrorRepository,
      engine: {} as MirrorEngine
    });

    try {
      if (!server.listening) await once(server, "listening");
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/health`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, service: "supamail" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      log.mockRestore();
    }
  });
});
