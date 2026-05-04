export class ImapThrottle {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxCommandsPerMinute: number,
    private readonly accountId: string
  ) {
    this.tokens = maxCommandsPerMinute;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    const waitMs = Math.ceil(60_000 / this.maxCommandsPerMinute);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return this.acquire();
  }

  getTokens(): number {
    this.refill();
    return this.tokens;
  }

  getAccountId(): string {
    return this.accountId;
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
