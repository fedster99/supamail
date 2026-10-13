import type { MirrorImapClient } from "./imap-client.js";
import type { ImapMessage } from "./types.js";

/** Bodies of mail dated in the newest 7 days never wait for a download budget. */
export const DOWNLOAD_BUDGET_EXEMPT_MS = 7 * 24 * 60 * 60_000;

/**
 * One pass's IMAP download meter and the host's download budget for it.
 *
 * Every byte the session receives counts. The budget gates only older mail's
 * bodies: bodies dated before the newest 7 days, in the body backlog and the
 * history lane. New mail, metadata, and recent bodies always download. Before
 * an older body would take the pass past the budget, older bodies stop for
 * the rest of the pass, so they still arrive newest first. A session that
 * cannot count its bytes gets no older bodies under a budget.
 */
export class PassDownloadMeter {
  /** Older bodies are dated before this. */
  readonly recentSince: Date;
  private readonly startBytes: number | undefined;
  private reached = false;

  constructor(
    private readonly client: MirrorImapClient,
    private readonly budgetBytes: number | undefined,
    private readonly maxBodyBytes: number,
    now = Date.now()
  ) {
    this.startBytes = client.receivedBytes?.();
    this.recentSince = new Date(now - DOWNLOAD_BUDGET_EXEMPT_MS);
  }

  /** IMAP bytes received since the pass began; undefined when the session cannot count them. */
  get downloadedBytes(): number | undefined {
    const now = this.client.receivedBytes?.();
    if (now === undefined || this.startBytes === undefined) return undefined;
    return Math.max(0, now - this.startBytes);
  }

  /** True once an older body waited on the budget in this pass. */
  get budgetReached(): boolean {
    return this.reached;
  }

  /** Whether this message's body waits on the budget. */
  gates(message: ImapMessage): boolean {
    return this.budgetBytes !== undefined
      && !(new Date(message.internal_date).getTime() >= this.recentSince.getTime());
  }

  /**
   * Admit one body download step. A step with older bodies fits only when its
   * expected size stays inside the budget; the first one that does not ends
   * older bodies for the pass.
   */
  admits(messages: readonly ImapMessage[]): boolean {
    const older = messages.filter((message) => this.gates(message));
    if (older.length === 0) return true;
    if (this.reached) return false;
    const expected = older.reduce((sum, message) => sum + this.expectedBytes(message), 0);
    if ((this.downloadedBytes ?? Number.POSITIVE_INFINITY) + expected > this.budgetBytes!) {
      this.reached = true;
      return false;
    }
    return true;
  }

  /** A body download is capped at the raw body limit; an unknown size counts as the cap. */
  private expectedBytes(message: ImapMessage): number {
    const size = Number(message.size_bytes);
    return Number.isSafeInteger(size) && size > 0
      ? Math.min(size, this.maxBodyBytes)
      : this.maxBodyBytes;
  }
}
