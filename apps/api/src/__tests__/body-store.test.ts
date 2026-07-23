import { describe, expect, it, vi } from "vitest";
import {
  DatabaseBodyStore,
  SEARCH_EXTRACT_MAX_BYTES,
  buildSearchExtract
} from "../body-store.js";
import type { MessageBodyInput } from "../types.js";

const body = {
  messageId: "00000000-0000-4000-8000-000000000001",
  rawMime: Buffer.from("body"),
  rawBytes: 4,
  rawTruncated: false,
  bodyText: "body",
  bodyHtml: "<p>body</p>",
  bodyPlain: "body",
  selectedTextPart: "1",
  selectedTextFormat: "plain",
  headersJson: {},
  mimeStructure: null,
  parserWarnings: [],
  evidence: []
} satisfies MessageBodyInput;

describe("body-store seam", () => {
  it("builds a plain-text extract capped at exactly 32 KiB of UTF-8", () => {
    const ascii = buildSearchExtract("a".repeat(SEARCH_EXTRACT_MAX_BYTES + 10));
    expect(Buffer.byteLength(ascii ?? "", "utf8")).toBe(SEARCH_EXTRACT_MAX_BYTES);

    const multibyte = buildSearchExtract("🙂".repeat(SEARCH_EXTRACT_MAX_BYTES));
    expect(Buffer.byteLength(multibyte ?? "", "utf8")).toBeLessThanOrEqual(SEARCH_EXTRACT_MAX_BYTES);
    expect(multibyte?.endsWith("🙂")).toBe(true);
    expect(multibyte).not.toContain("\uFFFD");
  });

  it("uses selected normalized plain text and preserves an absent body", () => {
    expect(buildSearchExtract("  selected plain text  ")).toBe("  selected plain text  ");
    expect(buildSearchExtract(null)).toBeNull();
  });

  it("keeps database payload storage as the default adapter", async () => {
    const storeBodyPayload = vi.fn(async () => undefined);
    const store = new DatabaseBodyStore({ storeBodyPayload } as never);

    await store.store(body);

    expect(storeBodyPayload).toHaveBeenCalledWith(body);
  });
});
