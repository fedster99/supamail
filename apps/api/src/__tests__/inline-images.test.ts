import { describe, expect, it } from "vitest";
import { buildRawMime } from "../smtp-client.js";
import { InvalidInputError } from "../errors.js";
import { referencedContentIds, validateInlineImages } from "../inline-images.js";

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
  it.each(["a", "aaa", "aaaa=", "a===", "=aaa", "aa=a", "aaaa\n", "____"])("rejects invalid base64 %j", async (content) => {
    await expect(buildRawMime({ ...request, attachments: [{ ...image, content }] }, { email: "sender@example.test" })).rejects.toBeInstanceOf(InvalidInputError);
  });
  it("validates large base64 payloads without exhausting the regexp stack", () => {
    for (const extra of [0, 1, 2]) {
      const content = Buffer.alloc(6 * 1024 * 1024 + extra).toString("base64");
      expect(() => validateInlineImages({ ...request, attachments: [{ ...image, content }] })).not.toThrow();
      expect(() => validateInlineImages({ ...request, attachments: [{ ...image, content: `${content.slice(0, -1)}!` }] })).toThrow(InvalidInputError);
    }
  });
  it.each([
    '<IMG SRC=" \tCID:Logo&#64;example.test\n ">',
    "<img src='cid:Logo%40example.test'>",
    '<img src=cid:Logo&#x40;example.test>',
    '<table background=" cid:Logo@example.test ">',
    '<a href="cid:Logo@example.test">image</a>',
    '<div style="background-image:url(&quot; cid:Logo@example.test &quot;)">',
    '<style>/* url(cid:unused) */ .logo {background:url( cid:Logo@example.test )}</style>'
  ])("reads normalized URLs from HTML attributes and CSS: %s", (html) => {
    expect([...referencedContentIds(html)]).toEqual(["Logo@example.test"]);
  });
  it("ignores comments, prose, script text and unrelated attributes", async () => {
    const html = '<!-- <img src="cid:old-logo"> --><p>Use src=cid:example or url(cid:example) in HTML</p><div title="src=cid:example"></div><script>const sample = \'<img src="cid:example">\';</script>';
    expect([...referencedContentIds(html)]).toEqual([]);
    await expect(buildRawMime({ ...request, body: { format: "html", html }, attachments: [] }, { email: "sender@example.test" })).resolves.toHaveProperty("raw");
  });
  it.each(['<img src=" cid:missing ">', '<img src="cid:missing&#64;example.test">', '<img src="cid:%ZZ">'])("rejects unresolved or malformed normalized URLs: %s", async (html) => {
    await expect(buildRawMime({ ...request, body: { format: "html", html }, attachments: [] }, { email: "sender@example.test" })).rejects.toBeInstanceOf(InvalidInputError);
  });
});
