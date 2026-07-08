import { beforeEach, describe, expect, it } from "vitest";
import { getConfig, isWithinBackfillWindow, resetConfigForTests } from "../config.js";

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

describe("config BACKFILL_WINDOW", () => {
  beforeEach(() => {
    resetConfigForTests();
  });

  it("defaults to no gate", () => {
    const config = getConfig(baseEnv);

    expect(config.BACKFILL_WINDOW_START_HOUR).toBeUndefined();
    expect(config.BACKFILL_WINDOW_END_HOUR).toBeUndefined();
    expect(config.BACKFILL_WINDOW_TIMEZONE).toBe("UTC");
    expect(isWithinBackfillWindow(config, new Date("2026-01-01T12:00:00.000Z"))).toBe(true);
  });

  it("accepts a wrapping overnight window", () => {
    const config = getConfig({
      ...baseEnv,
      BACKFILL_WINDOW_START_HOUR: "23",
      BACKFILL_WINDOW_END_HOUR: "4",
      BACKFILL_WINDOW_TIMEZONE: "UTC"
    });

    expect(isWithinBackfillWindow(config, new Date("2026-01-01T22:59:00.000Z"))).toBe(false);
    expect(isWithinBackfillWindow(config, new Date("2026-01-01T23:00:00.000Z"))).toBe(true);
    expect(isWithinBackfillWindow(config, new Date("2026-01-02T03:59:00.000Z"))).toBe(true);
    expect(isWithinBackfillWindow(config, new Date("2026-01-02T04:00:00.000Z"))).toBe(false);
  });

  it("uses the configured IANA time zone", () => {
    const config = getConfig({
      ...baseEnv,
      BACKFILL_WINDOW_START_HOUR: "23",
      BACKFILL_WINDOW_END_HOUR: "4",
      BACKFILL_WINDOW_TIMEZONE: "America/Los_Angeles"
    });

    expect(isWithinBackfillWindow(config, new Date("2026-01-02T07:30:00.000Z"))).toBe(true);
    expect(isWithinBackfillWindow(config, new Date("2026-01-02T12:30:00.000Z"))).toBe(false);
  });

  it("accepts a non-wrapping same-day window", () => {
    const config = getConfig({
      ...baseEnv,
      BACKFILL_WINDOW_START_HOUR: "1",
      BACKFILL_WINDOW_END_HOUR: "3",
      BACKFILL_WINDOW_TIMEZONE: "UTC"
    });

    expect(isWithinBackfillWindow(config, new Date("2026-01-01T00:59:00.000Z"))).toBe(false);
    expect(isWithinBackfillWindow(config, new Date("2026-01-01T01:00:00.000Z"))).toBe(true);
    expect(isWithinBackfillWindow(config, new Date("2026-01-01T02:59:00.000Z"))).toBe(true);
    expect(isWithinBackfillWindow(config, new Date("2026-01-01T03:00:00.000Z"))).toBe(false);
  });

  it("rejects incomplete or ambiguous windows", () => {
    expect(() => getConfig({ ...baseEnv, BACKFILL_WINDOW_START_HOUR: "23" })).toThrow();
    resetConfigForTests();
    expect(() => getConfig({ ...baseEnv, BACKFILL_WINDOW_END_HOUR: "4" })).toThrow();
    resetConfigForTests();
    expect(() => getConfig({
      ...baseEnv,
      BACKFILL_WINDOW_START_HOUR: "4",
      BACKFILL_WINDOW_END_HOUR: "4"
    })).toThrow();
  });

  it("rejects invalid hours and time zones", () => {
    expect(() => getConfig({
      ...baseEnv,
      BACKFILL_WINDOW_START_HOUR: "24",
      BACKFILL_WINDOW_END_HOUR: "4"
    })).toThrow();
    resetConfigForTests();
    expect(() => getConfig({
      ...baseEnv,
      BACKFILL_WINDOW_START_HOUR: "23",
      BACKFILL_WINDOW_END_HOUR: "4",
      BACKFILL_WINDOW_TIMEZONE: "Not/AZone"
    })).toThrow();
  });
});
