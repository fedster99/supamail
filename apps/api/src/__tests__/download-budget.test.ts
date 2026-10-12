import { describe, expect, it } from "vitest";
import { DOWNLOAD_BUDGET_EXEMPT_MS, PassDownloadMeter } from "../download-budget.js";
import type { MirrorImapClient } from "../imap-client.js";
import type { ImapMessage } from "../types.js";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const MAX_BODY = 1_000;

function session(start = 500) {
  let received = start;
  return {
    client: { receivedBytes: () => received } as unknown as MirrorImapClient,
    receive(bytes: number) {
      received += bytes;
    }
  };
}

function message(ageMs: number, size: number | null = 100): ImapMessage {
  return { internal_date: new Date(NOW - ageMs), size_bytes: size } as ImapMessage;
}

describe("PassDownloadMeter", () => {
  it("counts only the bytes received during the pass", () => {
    const pass = session(10_000);
    const meter = new PassDownloadMeter(pass.client, undefined, MAX_BODY, NOW);

    expect(meter.downloadedBytes).toBe(0);
    pass.receive(1_234);
    expect(meter.downloadedBytes).toBe(1_234);
  });

  it("never gates anything without a budget", () => {
    const meter = new PassDownloadMeter(session().client, undefined, MAX_BODY, NOW);

    expect(meter.gates(message(400 * DAY))).toBe(false);
    expect(meter.admits([message(400 * DAY, 10_000_000)])).toBe(true);
    expect(meter.budgetReached).toBe(false);
  });

  it("never gates bodies from the newest 7 days", () => {
    const meter = new PassDownloadMeter(session().client, 0, MAX_BODY, NOW);

    expect(meter.gates(message(DOWNLOAD_BUDGET_EXEMPT_MS - 1))).toBe(false);
    expect(meter.gates(message(DOWNLOAD_BUDGET_EXEMPT_MS + 1))).toBe(true);
    expect(meter.admits([message(DAY)])).toBe(true);
  });

  it("admits older bodies while they fit and stops them at the first that does not", () => {
    const pass = session();
    const meter = new PassDownloadMeter(pass.client, 250, MAX_BODY, NOW);

    expect(meter.admits([message(30 * DAY, 100), message(31 * DAY, 100)])).toBe(true);
    pass.receive(200);
    // 200 downloaded + 100 expected passes 250: older bodies stop for the pass.
    expect(meter.admits([message(32 * DAY, 100)])).toBe(false);
    expect(meter.budgetReached).toBe(true);
    expect(meter.admits([message(33 * DAY, 1)])).toBe(false);
    // Recent bodies still download, and every byte counts.
    expect(meter.admits([message(DAY, 10_000)])).toBe(true);
  });

  it("charges a body at the raw cap when its size is unknown or larger", () => {
    const meter = new PassDownloadMeter(session().client, MAX_BODY, MAX_BODY, NOW);

    expect(meter.admits([message(30 * DAY, 50_000)])).toBe(true);
    expect(meter.admits([message(30 * DAY, null), message(30 * DAY, 1)])).toBe(false);
  });

  it("reports the budget reached only once an older body waited", () => {
    const meter = new PassDownloadMeter(session().client, 0, MAX_BODY, NOW);

    expect(meter.admits([message(DAY, 1)])).toBe(true);
    expect(meter.budgetReached).toBe(false);
    expect(meter.admits([message(30 * DAY, 1)])).toBe(false);
    expect(meter.budgetReached).toBe(true);
  });

  it("fails closed when the session cannot count bytes", () => {
    const meter = new PassDownloadMeter({} as MirrorImapClient, 10_000, MAX_BODY, NOW);

    expect(meter.downloadedBytes).toBeUndefined();
    expect(meter.admits([message(30 * DAY, 1)])).toBe(false);
    expect(meter.budgetReached).toBe(true);
    expect(meter.admits([message(DAY, 1)])).toBe(true);
  });
});
