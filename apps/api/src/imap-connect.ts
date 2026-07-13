import { ImapFlow } from "imapflow";
import type { AppConfig } from "./config.js";
import { decryptPassword } from "./crypto.js";
import type { PgPool } from "./db.js";
import { assertSafeImapTarget } from "./host-validation.js";
import type { ImapAccount } from "./types.js";

/**
 * The one shared IMAP connect prelude (ADR 0017/0018/0020/0022). Every narrow IMAP
 * client in this codebase — the read-sync `ThrottledImapClient` (imap-client.ts),
 * the append-only `SentFolderAppender` (smtp-client.ts), the mutation
 * `MailboxMutator` (mailbox-mutations.ts), and the download/fetch `ContentImapClient`
 * (content.ts) — obtains its socket here, then wraps it with its OWN distinct verb
 * surface. This module deliberately lives OUTSIDE `src/mcp/`: it constructs an
 * ImapFlow (which can write), so it must never be importable from the zero-send
 * agent surface (`agent-surface-zero-send.test.ts`).
 *
 * The prelude owns four things that are security-/reliability-load-bearing and were
 * previously copied four times:
 *   1. `assertSafeImapTarget` — the SSRF / port / TLS guard.
 *   2. `decryptPassword` — the frozen AES-256-GCM envelope (ADR 0002).
 *   3. ImapFlow construction with the exact timeout wiring.
 *   4. The close-on-connect-error guard — if `connect()` throws (auth/TLS failure),
 *      the socket is closed before rethrowing so it cannot leak. This guard had
 *      drifted: it lived in MailboxMutator/ContentImapClient but was MISSING from
 *      createImapClient/SentFolderAppender. Centralizing it here makes all four
 *      clients fail-closed uniformly.
 *
 * Returns the raw connected {@link ImapFlow}; the caller is responsible for the
 * verb surface it exposes on top (read-only / append-only / mutate / fetch). The
 * connect/decrypt/SSRF policy can no longer drift between those clients.
 */
export async function connectImap(
  pool: PgPool,
  config: AppConfig,
  account: ImapAccount,
  options: { signal?: AbortSignal } = {}
): Promise<ImapFlow> {
  await assertSafeImapTarget(account.host, account.port, account.secure, {
    allowPrivateHosts: config.IMAP_ALLOW_PRIVATE_HOSTS
  });
  const password = await decryptPassword(pool, account.encrypted_password, config.IMAP_ENCRYPTION_KEY);
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.username, pass: password },
    logger: false,
    connectionTimeout: config.CONNECT_TIMEOUT_MS,
    greetingTimeout: config.CONNECT_TIMEOUT_MS,
    socketTimeout: config.IMAP_COMMAND_TIMEOUT_MS
  });
  if (options.signal?.aborted) {
    client.close();
    throw new Error("IMAP connection interrupted for higher-priority sync work");
  }
  let closedForInterrupt = false;
  let interruptConnect: (() => void) | null = null;
  const interrupted = options.signal
    ? new Promise<never>((_, reject) => {
      interruptConnect = () => {
        closedForInterrupt = true;
        client.close();
        reject(new Error("IMAP connection interrupted for higher-priority sync work"));
      };
      options.signal?.addEventListener("abort", interruptConnect, { once: true });
    })
    : null;
  try {
    await (interrupted ? Promise.race([client.connect(), interrupted]) : client.connect());
  } catch (error) {
    // Close the socket so an auth/TLS failure during connect cannot leak it.
    if (!closedForInterrupt) client.close();
    throw error;
  } finally {
    if (interruptConnect) {
      options.signal?.removeEventListener("abort", interruptConnect);
    }
  }
  return client;
}

/**
 * A client that can be torn down: a graceful IMAP LOGOUT, falling back to a hard
 * socket close. The narrow write/fetch clients (SentFolderAppender, MailboxMutator,
 * ContentImapClient) each expose exactly this pair, so {@link closeImap} can tear
 * any of them down uniformly.
 */
export interface ClosableImapClient {
  logout(): Promise<void>;
  close(): void;
}

/**
 * The one shared IMAP teardown twin of {@link connectImap} (review maintainability
 * finding): try a graceful LOGOUT, and if that rejects (already-broken socket, a
 * timed-out command) fall back to a hard `close()` so the socket can never leak.
 * This `await client.logout().catch(() => client.close())` was copy-pasted ~13×
 * across the appender / mutator / fetch clients; centralizing it keeps the
 * disconnect policy from drifting the way the connect prelude already prevents for
 * connect. Behavior is byte-identical to the inlined teardown it replaces.
 */
export async function closeImap(client: ClosableImapClient): Promise<void> {
  await client.logout().catch(() => client.close());
}

/**
 * The one shared UIDVALIDITY fail-closed comparison (CC-4, co-located with the
 * connector). The mutate path (`MailboxMutator.withUidScope`) and the on-demand
 * fetch path (`ContentImapClient.assertUidValidity`) implement the SAME property —
 * "a UIDVALIDITY reset must never let us act on / fetch the wrong message" — so the
 * comparison + message live here once.
 *
 * Returns `true` when the live mailbox UIDVALIDITY still matches what we mirrored
 * (or no mailbox is selected); returns `false` on a mismatch. Each caller keeps its
 * OWN thrown error type (mutations throw `MailboxConflictError` → HTTP 409; content
 * throws a plain `Error`), so this shared check changes no existing error contract —
 * the call site decides how to fail. `verb` tunes the message ("mutate" / "fetch").
 */
export function uidValidityMatches(
  mailbox: { uidValidity?: bigint | number } | false | null | undefined,
  expectedUidValidity: number
): boolean {
  if (!mailbox) return true;
  return Number(mailbox.uidValidity) === expectedUidValidity;
}

/**
 * Build the standard UIDVALIDITY-mismatch message. Shared so the read and mutate
 * paths describe the same fail-closed condition identically; `verb` is the action
 * being refused ("mutate" / "fetch").
 */
export function uidValidityMismatchMessage(
  folderPath: string,
  expectedUidValidity: number,
  serverUidValidity: bigint | number | undefined,
  verb: string
): string {
  return `UIDVALIDITY changed for ${folderPath} (mirror ${expectedUidValidity} != server ${serverUidValidity}); refusing to ${verb} by stale UID`;
}
