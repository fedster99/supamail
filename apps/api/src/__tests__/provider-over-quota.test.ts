import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeSyncError,
  isAuthError,
  isConnectionLostError,
  isProviderOverQuotaError
} from "../sync-engine.js";
import { diagnosticErrorCode } from "../sync-diagnostics.js";

/**
 * Gmail suspends IMAP for 1–24 hours when an account passes its bandwidth
 * limit and answers with RFC 5530 OVERQUOTA. These tests drive the real,
 * patched imapflow against a scripted server, so the classification rests on
 * what the client really reports, not on a hand-built error object.
 */

const OVER_QUOTA_TEXT = "Account exceeded command or bandwidth limits";

type Reply = (socket: Socket, tag: string) => void;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function scriptedServer(replies: { login: Reply; select?: Reply }): Promise<number> {
  const server = createServer((socket) => {
    socket.write("* OK [CAPABILITY IMAP4rev1] ready\r\n");
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffered.indexOf("\r\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 2);
        const [tag, command = ""] = line.split(" ");
        switch (command.toUpperCase()) {
          case "CAPABILITY":
            socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
            break;
          case "ID":
            socket.write(`* ID NIL\r\n${tag} OK done\r\n`);
            break;
          case "LOGIN":
            replies.login(socket, tag);
            break;
          case "SELECT":
            (replies.select ?? ((s, t) => s.write(`${t} OK done\r\n`)))(socket, tag);
            break;
          case "LOGOUT":
            socket.end(`* BYE bye\r\n${tag} OK done\r\n`);
            break;
          default:
            socket.write(`${tag} OK done\r\n`);
        }
      }
    });
    socket.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function client(port: number): ImapFlow {
  const imap = new ImapFlow({
    host: "127.0.0.1",
    port,
    secure: false,
    auth: { user: "owner@example.test", pass: "app-password" },
    logger: false,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000
  });
  imap.on("error", () => undefined);
  return imap;
}

async function connectError(port: number): Promise<unknown> {
  const imap = client(port);
  try {
    await imap.connect();
  } catch (error) {
    return error;
  } finally {
    imap.close();
  }
  throw new Error("expected the login to fail");
}

const bye: Reply = (socket) => socket.end(`* BYE [OVERQUOTA] ${OVER_QUOTA_TEXT}\r\n`);

describe("provider OVERQUOTA is a temporary limit, never a rejected password", () => {
  it("classifies a tagged NO [OVERQUOTA] at LOGIN as over quota", async () => {
    const error = await connectError(await scriptedServer({
      login: (socket, tag) => socket.write(`${tag} NO [OVERQUOTA] ${OVER_QUOTA_TEXT}\r\n`)
    }));

    expect(error).toMatchObject({ authenticationFailed: true, serverResponseCode: "OVERQUOTA" });
    expect(isProviderOverQuotaError(error)).toBe(true);
    expect(isAuthError(error)).toBe(false);
    expect(describeSyncError(error)).not.toContain("[AUTH]");
    expect(diagnosticErrorCode(describeSyncError(error))).toBe("RATE_LIMITED");
  });

  it("classifies a BYE [OVERQUOTA] that ends the LOGIN as over quota", async () => {
    const error = await connectError(await scriptedServer({ login: bye }));

    expect(isProviderOverQuotaError(error)).toBe(true);
    expect(isAuthError(error)).toBe(false);
    expect(diagnosticErrorCode(describeSyncError(error))).toBe("RATE_LIMITED");
  });

  it("classifies a BYE [OVERQUOTA] in the middle of a session as over quota", async () => {
    const imap = client(await scriptedServer({
      login: (socket, tag) => socket.write(`${tag} OK logged in\r\n`),
      select: bye
    }));
    await imap.connect();
    const error = await imap.mailboxOpen("INBOX").then(() => null, (failure: unknown) => failure);
    imap.close();

    expect(isConnectionLostError(error)).toBe(true);
    expect(isProviderOverQuotaError(error)).toBe(true);
    expect(diagnosticErrorCode(describeSyncError(error))).toBe("RATE_LIMITED");
  });

  it("still classifies a real credential rejection as an auth error", async () => {
    const error = await connectError(await scriptedServer({
      login: (socket, tag) => socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`)
    }));

    expect(isProviderOverQuotaError(error)).toBe(false);
    expect(isAuthError(error)).toBe(true);
    expect(diagnosticErrorCode(describeSyncError(error))).toBe("AUTH_ERROR");
  });

  it("keeps a plain BYE without a response code a lost connection, not over quota", async () => {
    const error = await connectError(await scriptedServer({
      login: (socket) => socket.end("* BYE Too many connections\r\n")
    }));

    expect(isProviderOverQuotaError(error)).toBe(false);
    expect(isAuthError(error)).toBe(false);
  });
});
