import { describe, expect, it } from "vitest";
import { buildRawMime } from "../smtp-client.js";
import { InvalidInputError } from "../errors.js";
import { referencedContentIds } from "../inline-images.js";

const image = { filename: "logo.png", contentType: "image/png", content: "cG5n", cid: "logo" };
const request = { accountId: "unused", to: [], subject: "Test", body: { format: "html" as const, html: '<img src="cid:logo">' }, attachments: [image] };

describe("CID validation before MIME composition", () => {
  it.each(["", "<logo>", "cid:logo", "a b", "x\r\nBcc: evil", "x".repeat(256)])("rejects malformed Content-ID %j", async (cid) => {
    await expect(buildRawMime({ ...request, attachments: [{ ...image, cid }] }, { email: "sender@example.test" })).rejects.toBeInstanceOf(InvalidInputError);
  });
  it.each([
    { attachments: [image, image] },
    { body: { format: "html" as const, html: '<img src="cid:">' } },
    { attachments: [{ ...image, content: "not base64" }] },
    { attachments: [] },
    { attachments: [{ ...image, inline: false }] },
    { attachments: [{ ...image, contentType: "application/pdf" }] },
    { attachments: [{ ...image, contentType: "image/svg+xml" }] },
    { attachments: [{ ...image, content: "" }] },
    { body: { format: "plain" as const, text: "Hello" } }
  ])("rejects unresolved or unsupported associations %j", async (patch) => {
    await expect(buildRawMime({ ...request, ...patch }, { email: "sender@example.test" })).rejects.toBeInstanceOf(InvalidInputError);
  });
  it("decodes CID URLs and preserves case without treating prose as image references", () => {
    expect([...referencedContentIds('<img src="cid:Logo%40example.test"><p>Use cid:foo</p>')]).toEqual(["Logo@example.test"]);
  });
});
