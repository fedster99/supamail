import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { buildRawMime, buildSendEnvelope } from "../smtp-client.js";
import type { SendRequest } from "../types.js";
const request: SendRequest = { accountId: "mailbox", to: [{ email: "receiver@example.com" }], subject: "Hello", body: { format: "plain", text: "Hello" } };
describe("sender display name", () => {
  it("encodes Unicode names without changing the mailbox address or envelope", async () => {
    const input = { ...request, senderName: 'Renée, at Example' };
    const { raw } = await buildRawMime(input, { email: "hello@example.com" });
    const parsed = await simpleParser(raw);
    expect(parsed.from?.value).toEqual([{ address: "hello@example.com", name: "Renée, at Example" }]);
    expect(buildSendEnvelope("hello@example.com", input).from).toBe("hello@example.com");
  });
  it.each(["Mallory\r\nBcc: other@example.com", "a\0b", "x".repeat(121)])("rejects invalid names before composition", async (senderName) => {
    await expect(buildRawMime({ ...request, senderName }, { email: "hello@example.com" })).rejects.toThrow("Sender name");
  });
  it("preserves existing behavior without a configured name", async () => {
    const { raw } = await buildRawMime(request, { email: "hello@example.com" });
    expect((await simpleParser(raw)).from?.value[0]).toEqual({ address: "hello@example.com", name: "" });
  });
});
