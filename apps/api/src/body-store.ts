import type { MirrorRepository } from "./repository.js";
import type { MessageBodyInput } from "./types.js";

export const SEARCH_EXTRACT_MAX_BYTES = 32 * 1024;

/**
 * The searchable representation is the parser's selected normalized plain text.
 * Bound it by UTF-8 bytes without splitting a code point.
 */
export function buildSearchExtract(value: string | null): string | null {
  if (value === null) return null;
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= SEARCH_EXTRACT_MAX_BYTES) return value;

  let end = SEARCH_EXTRACT_MAX_BYTES;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

export interface BodyStore {
  store(body: MessageBodyInput): Promise<void>;
}

/** OSS default: retain today's database body payload and BODY_STORAGE_MODE behavior. */
export class DatabaseBodyStore implements BodyStore {
  constructor(private readonly repository: Pick<MirrorRepository, "storeBodyPayload">) {}

  async store(body: MessageBodyInput): Promise<void> {
    await this.repository.storeBodyPayload(body);
  }
}
