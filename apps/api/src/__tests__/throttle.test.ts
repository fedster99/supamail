import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapThrottle } from "../throttle.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ImapThrottle", () => {
  it("interrupts a queued command when its scheduler signal aborts", async () => {
    vi.useFakeTimers();
    const throttle = new ImapThrottle(1);
    const abort = new AbortController();

    await throttle.acquire();
    const queued = throttle.acquire(abort.signal);
    abort.abort();

    await expect(queued).rejects.toThrow(/interrupted/);
    expect(vi.getTimerCount()).toBe(0);
  });
});
