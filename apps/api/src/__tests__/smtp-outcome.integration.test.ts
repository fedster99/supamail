import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { deliverSmtp, SmtpDeliveryError } from "../smtp-client.js";

const servers: Array<ReturnType<typeof createServer>> = [];

async function smtpServer({
  loseFinalResponse = false,
  truncatePositiveFinalResponse = false,
  withholdGreeting = false,
} = {}) {
  let acceptedMessages = 0;
  const server = createServer((socket: Socket) => {
    let buffer = "";
    let readingData = false;
    if (withholdGreeting) return;
    socket.write("220 localhost ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        if (readingData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          buffer = buffer.slice(end + 5);
          acceptedMessages += 1;
          if (loseFinalResponse) {
            socket.destroy();
            return;
          }
          if (truncatePositiveFinalResponse) {
            socket.end("250 2.0.0 queued");
            return;
          }
          readingData = false;
          socket.write("250 2.0.0 queued\r\n");
          continue;
        }

        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (/^EHLO /i.test(line)) socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
        else if (/^AUTH /i.test(line)) socket.write("235 2.7.0 authenticated\r\n");
        else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write("250 2.1.0 ok\r\n");
        else if (line === "DATA") {
          readingData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (line === "QUIT") {
          socket.end("221 2.0.0 bye\r\n");
        } else {
          socket.write("250 2.0.0 ok\r\n");
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SMTP test server has no port");
  return {
    port: address.port,
    acceptedMessages: () => acceptedMessages,
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
});

describe("SMTP outcome boundary", () => {
  const raw = Buffer.from(
    "From: sender@example.test\r\nTo: rcpt@example.test\r\nSubject: Test\r\n\r\nBody\r\n"
  );
  const envelope = { from: "sender@example.test", to: ["rcpt@example.test"] };
  const config = {
    CONNECT_TIMEOUT_MS: 1_000,
    IMAP_COMMAND_TIMEOUT_MS: 1_000,
  } as never;

  it("returns a receipt after the server confirms DATA", async () => {
    const server = await smtpServer();
    const receipt = await deliverSmtp(
      {
        host: "127.0.0.1",
        port: server.port,
        secure: false,
        username: "sender",
        password: "secret",
      },
      raw,
      envelope,
      config,
      { isPrivateHost: true }
    );

    expect(receipt.accepted).toEqual(["rcpt@example.test"]);
    expect(server.acceptedMessages()).toBe(1);
  });

  it("reports not delivered when the server never sends its greeting", async () => {
    const server = await smtpServer({ withholdGreeting: true });
    const error = await deliverSmtp(
      {
        host: "127.0.0.1",
        port: server.port,
        secure: false,
        username: "sender",
        password: "secret",
      },
      raw,
      envelope,
      config,
      { isPrivateHost: true }
    ).catch((value) => value);

    expect(error).toBeInstanceOf(SmtpDeliveryError);
    expect(error.cause).toMatchObject({
      code: "ETIMEDOUT",
      command: "CONN",
    });
    expect(error.outcome).toBe("not_delivered");
    expect(server.acceptedMessages()).toBe(0);
  });

  it("reports unknown when the server accepts DATA but loses the final response", async () => {
    const server = await smtpServer({ loseFinalResponse: true });
    const error = await deliverSmtp(
      {
        host: "127.0.0.1",
        port: server.port,
        secure: false,
        username: "sender",
        password: "secret",
      },
      raw,
      envelope,
      config,
      { isPrivateHost: true }
    ).catch((value) => value);

    expect(error).toBeInstanceOf(SmtpDeliveryError);
    expect(error.outcome).toBe("unknown");
    expect(server.acceptedMessages()).toBe(1);
  });

  it("reports unknown when the server accepts DATA then truncates a positive final response", async () => {
    const server = await smtpServer({ truncatePositiveFinalResponse: true });
    const error = await deliverSmtp(
      {
        host: "127.0.0.1",
        port: server.port,
        secure: false,
        username: "sender",
        password: "secret",
      },
      raw,
      envelope,
      config,
      { isPrivateHost: true }
    ).catch((value) => value);

    expect(error).toBeInstanceOf(SmtpDeliveryError);
    expect(error.outcome).toBe("unknown");
    expect(server.acceptedMessages()).toBe(1);
  });
});
