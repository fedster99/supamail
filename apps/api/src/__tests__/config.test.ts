import { beforeEach, describe, expect, it } from "vitest";
import { getConfig, resetConfigForTests } from "../config.js";

const baseEnv = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/postgres",
  IMAP_ENCRYPTION_KEY: "test-encryption-key"
};

describe("config BODY_STORAGE_MODE", () => {
  beforeEach(() => {
    resetConfigForTests();
  });

  it("defaults to raw_mime", () => {
    expect(getConfig(baseEnv).BODY_STORAGE_MODE).toBe("raw_mime");
  });

  it("accepts parsed_only", () => {
    expect(getConfig({ ...baseEnv, BODY_STORAGE_MODE: "parsed_only" }).BODY_STORAGE_MODE).toBe("parsed_only");
  });

  it("rejects unknown storage modes", () => {
    expect(() => getConfig({ ...baseEnv, BODY_STORAGE_MODE: "metadata" })).toThrow();
  });
});
