export class ImapThrottle {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly maxCommandsPerMinute: number) {
    this.tokens = maxCommandsPerMinute;
    this.lastRefill = Date.now();
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    while (true) {
      if (signal?.aborted) {
        throw new Error("IMAP throttle wait interrupted by scheduler");
      }
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(60_000 / this.maxCommandsPerMinute);
      await this.wait(waitMs, signal);
    }
  }

  private async wait(waitMs: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(new Error("IMAP throttle wait interrupted by scheduler"));
      };
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, waitMs);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs <= 0) return;

    const tokensToAdd = (elapsedMs / 60_000) * this.maxCommandsPerMinute;
    this.tokens = Math.min(this.maxCommandsPerMinute, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}
