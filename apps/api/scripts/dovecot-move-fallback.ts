import assert from "node:assert/strict";
import { ImapFlow } from "imapflow";

/** Real Dovecot effects, with COPY rejected by Dovecot and later failures injected
 * at the client's command boundary. Only the moving client loses MOVE capability. */
export async function checkMoveFallback(port: number, user: string, pass: string) {
  const results = [];
  for (const fault of ["copy_rejected", "store_rejected", "expunge_rejected", "copy_disconnect", "removal_disconnect", "none"] as const) {
    const source = `Fallback-${fault}-Source`;
    const destination = `Fallback-${fault}-Destination`;
    const newClient = () => {
      const client = new ImapFlow({ host: "127.0.0.1", port, secure: false, auth: { user, pass }, logger: false });
      client.on("error", () => {}); // Expected for deliberately closed connections.
      return client;
    };
    const observer = newClient();
    const moving = newClient();
    const commands: string[] = [];
    try {
      await observer.connect();
      await observer.mailboxCreate(source);
      if (fault !== "copy_rejected") await observer.mailboxCreate(destination);
      const messageIds = [1, 2].map((n) => `<fallback-${fault}-${n}@example.test>`);
      for (const messageId of messageIds) {
        await observer.append(source, `From: test@example.test\r\nTo: test@example.test\r\nMessage-ID: ${messageId}\r\nSubject: fallback fixture\r\n\r\nSynthetic lab email.\r\n`);
      }
      await moving.connect();
      moving.capabilities.delete("MOVE");
      assert.equal(moving.capabilities.has("UIDPLUS"), true);
      const lock = await moving.getMailboxLock(source);
      const uids = await moving.search({ all: true }, { uid: true });
      assert.ok(uids && uids.length === 2);
      const exec = Reflect.get(moving, "exec") as (...args: unknown[]) => Promise<unknown>;
      Reflect.set(moving, "exec", async (command: string, ...args: unknown[]) => {
        commands.push(command);
        const reject = (fault === "store_rejected" && command === "UID STORE")
          || (fault === "expunge_rejected" && command === "UID EXPUNGE");
        const disconnect = (fault === "copy_disconnect" && command === "UID COPY")
          || (fault === "removal_disconnect" && command === "UID STORE");
        if (disconnect) moving.close();
        if (reject || disconnect) throw Object.assign(new Error(`Injected ${fault}`), { responseStatus: "NO" });
        return exec.call(moving, command, ...args);
      });
      let result: Awaited<ReturnType<ImapFlow["messageMove"]>> | undefined;
      let error: unknown;
      try {
        result = await moving.messageMove(uids.join(","), destination, { uid: true });
      } catch (cause) {
        error = cause;
      } finally {
        lock.release();
      }
      const copyFailed = fault === "copy_rejected" || fault === "copy_disconnect";
      if (copyFailed) {
        assert.equal(result, false);
        assert.equal(commands.includes("UID STORE"), false, "a failed COPY must never delete originals");
      } else if (fault !== "none") {
        assert.equal((error as { code?: string })?.code, "MoveIncomplete");
        assert.equal(result, undefined, "a partial effect cannot return a successful COPYUID map");
      } else {
        assert.equal(error, undefined);
        assert.ok(result && result.uidMap?.size === 2);
      }
      if (fault === "store_rejected") assert.equal(commands.includes("UID EXPUNGE"), false);
      const sourceStatus = await observer.status(source, { messages: true });
      assert.equal(sourceStatus.messages, fault === "none" ? 0 : 2);
      const destinationCount = fault === "copy_rejected" ? 0 : (await observer.status(destination, { messages: true })).messages;
      assert.equal(destinationCount, copyFailed ? 0 : 2);
      if (fault === "none" && result) {
        const destinationLock = await observer.getMailboxLock(destination);
        try {
          for (const [index, uid] of uids.entries()) {
            const copied = await observer.fetchOne(String(result.uidMap!.get(uid)), { envelope: true }, { uid: true });
            assert.ok(copied && copied.envelope?.messageId === messageIds[index], "COPYUID must preserve email identity");
          }
        } finally { destinationLock.release(); }
      }
      results.push({ fault, commands, source: sourceStatus.messages, destination: destinationCount });
    } finally {
      await moving.logout().catch(() => moving.close());
      await observer.logout().catch(() => observer.close());
    }
  }
  return results;
}
