import net from "node:net";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { searchMailboxUids, ThrottledImapClient } from "../imap-client.js";

// A scripted IMAP server that answers like Purelymail did on 2026-10-18: a
// removal made by another session is queued for this one while it has INBOX
// selected, and is delivered as a live `* VANISHED` on the first command after
// the next SELECT. That SELECT already excludes the message, reports it as
// VANISHED (EARLIER), and sends no [CLOSED] code (RFC 7162 3.2.11).
class PurelymailLikeServer {
  readonly uidValidity = 750149938;
  uids: number[];
  modseq = 42;
  /** Live notices queued for the session's current selection. */
  private queued: string[] = [];
  private selected: string | null = null;
  private socket: net.Socket | null = null;
  readonly commands: string[] = [];
  private server = net.createServer((socket) => this.accept(socket));

  constructor(count: number) {
    this.uids = Array.from({ length: count }, (_, i) => i + 1);
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return (this.server.address() as net.AddressInfo).port;
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Another session moves `uid` out of INBOX while this one has it selected. */
  removeElsewhere(uid: number): void {
    this.uids = this.uids.filter((value) => value !== uid);
    this.modseq += 2;
    if (this.selected === "INBOX") this.queued.push(`* VANISHED ${uid}`);
  }

  private accept(socket: net.Socket): void {
    this.socket = socket;
    socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        this.answer(socket, line);
      }
    });
  }

  private answer(socket: net.Socket, line: string): void {
    const [tag, ...rest] = line.split(" ");
    const text = rest.join(" ");
    const verb = (/^UID /i.test(text) ? text.split(" ").slice(0, 2).join(" ") : text.split(" ")[0]).toUpperCase();
    this.commands.push(verb);
    const send = (...lines: string[]): void => {
      socket.write(lines.map((value) => `${value}\r\n`).join(""));
    };
    const caps = "IMAP4rev1 AUTH=PLAIN ENABLE CONDSTORE QRESYNC UIDPLUS MOVE UNSELECT";
    // Purelymail delivers queued notices with any command but SELECT.
    const flush = () => {
      const pending = this.queued;
      this.queued = [];
      return pending;
    };
    switch (verb) {
      case "CAPABILITY":
        return send(`* CAPABILITY ${caps}`, `${tag} OK done`);
      case "LOGIN":
        return send(`${tag} OK [CAPABILITY ${caps}] logged in`);
      case "ENABLE":
        return send("* ENABLED QRESYNC", `${tag} OK enabled`);
      case "LIST":
        return send('* LIST () "/" INBOX', `${tag} OK done`);
      case "SELECT": {
        this.queued = this.selected === "INBOX" ? this.queued : [];
        const replay = /QRESYNC \(\d+ \d+ ([^)]+)\)/i.exec(text);
        const lines = [
          "* FLAGS (\\Seen \\Deleted)",
          `* ${this.uids.length} EXISTS`,
          `* OK [UIDVALIDITY ${this.uidValidity}] ok`,
          `* OK [UIDNEXT ${Math.max(0, ...this.uids) + 100}] ok`,
          `* OK [HIGHESTMODSEQ ${this.modseq}] ok`
        ];
        if (replay) {
          const known = replay[1].split(":").map(Number);
          const gone = [];
          for (let uid = known[0]; uid <= (known[1] ?? known[0]); uid += 1) {
            if (!this.uids.includes(uid)) gone.push(uid);
          }
          if (gone.length) lines.push(`* VANISHED (EARLIER) ${gone.join(",")}`);
        }
        // The queued notice survives this SELECT and is not preceded by [CLOSED].
        this.selected = "INBOX";
        return send(...lines, `${tag} OK [READ-WRITE] selected`);
      }
      case "UID SEARCH":
        return send(...flush(), `* SEARCH ${this.uids.join(" ")}`, `${tag} OK done`);
      case "NOOP":
        return send(...flush(), `${tag} OK done`);
      case "UNSELECT":
        this.selected = null;
        this.queued = [];
        return send(`${tag} OK done`);
      case "LOGOUT":
        return send("* BYE", `${tag} OK bye`);
      default:
        return send(...flush(), `${tag} OK done`);
    }
  }
}

describe("a warm session after another session removes a message", () => {
  let server: PurelymailLikeServer | null = null;
  let raw: ImapFlow | null = null;

  afterEach(async () => {
    await raw?.logout().catch(() => undefined);
    raw?.close();
    await server?.close();
    server = null;
    raw = null;
  });

  it("counts the folder the provider lists after a QRESYNC re-select", async () => {
    server = new PurelymailLikeServer(72);
    const port = await server.listen();
    raw = new ImapFlow({
      host: "127.0.0.1",
      port,
      secure: false,
      auth: { user: "u", pass: "p" },
      logger: false,
      qresync: true,
      disableAutoIdle: true
    });
    raw.on("error", () => undefined);
    const client = new ThrottledImapClient(raw, 1_000, 5_000);
    await client.connect();

    // Pass 1 leaves INBOX selected on the reused session.
    const first = await client.getMailboxLock("INBOX");
    expect(client.mailbox && client.mailbox.exists).toBe(72);
    first.release();

    // An agent's move runs on another session: INBOX now holds 71.
    server.removeElsewhere(72);

    // Pass 2 re-selects with the QRESYNC cursor and runs the reconcile search.
    client.invalidateSelection();
    const second = await client.getMailboxLock("INBOX", {
      qresync: { uidValidity: BigInt(server.uidValidity), changedSince: 42n, knownUids: "1:72" }
    });
    expect(second.qresync?.vanishedUids).toEqual([72]);
    const uids = await searchMailboxUids(client, { all: true });
    second.release();

    expect(uids).toHaveLength(71);
    expect(client.mailbox && client.mailbox.exists).toBe(71);

    // Switching to another folder costs no NOOP; only a re-select collects first.
    const other = await client.getMailboxLock("Archive");
    other.release();
    expect(server.commands.filter((verb) => ["SELECT", "NOOP", "UID SEARCH"].includes(verb)))
      .toEqual(["SELECT", "NOOP", "SELECT", "UID SEARCH", "SELECT"]);
  });
});
