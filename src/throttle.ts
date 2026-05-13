export class ImapThrottle {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly maxCommandsPerMinute: number) {
    this.tokens = maxCommandsPerMinute;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(60_000 / this.maxCommandsPerMinute);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
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
