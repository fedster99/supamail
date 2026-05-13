import { simpleParser } from "mailparser";
import type { AttachmentMetadata } from "./types.js";

type BodyTextFormat = "plain" | "html";

const MAX_BODYSTRUCTURE_DEPTH = 64;
const MAX_HTML_PARSE_BYTES = 1_048_576;

export interface BodyTextPartChoice {
  part: string;
  format: BodyTextFormat;
}

interface BodyStructurePart {
  part?: string;
  type?: string;
  subtype?: string;
  size?: number;
  id?: string;
  disposition?: string | { type?: string; params?: { filename?: string } };
  dispositionParameters?: { filename?: string };
  parameters?: { name?: string };
  childNodes?: BodyStructurePart[];
}

export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.trim().replace(/^<|>$/g, "").toLowerCase() || null;
}

export function parseHeaders(raw: Buffer | string | null | undefined): Record<string, string> {
  if (!raw) return {};
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  const headers: Record<string, string> = {};
  let currentKey: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === "") continue;

    if (currentKey && /^[ \t]/.test(rawLine)) {
      headers[currentKey] = `${headers[currentKey]} ${rawLine.trim()}`.trim();
      continue;
    }

    const index = rawLine.indexOf(":");
    if (index > 0) {
      const key = rawLine.slice(0, index).trim().toLowerCase();
      const value = rawLine.slice(index + 1).trim();
      headers[key] = value;
      currentKey = key;
    }
  }

  return headers;
}

function dispositionType(part: BodyStructurePart): string | null {
  if (typeof part.disposition === "string") return part.disposition.toLowerCase();
  if (part.disposition && typeof part.disposition === "object") {
    return (part.disposition.type || "").toLowerCase() || null;
  }
  return null;
}

function mimeType(part: BodyStructurePart): string {
  const typeRaw = String(part.type || "").toLowerCase().split(";")[0].trim();
  const subtypeRaw = String(part.subtype || "").toLowerCase().split(";")[0].trim();

  if (typeRaw.includes("/")) return typeRaw.replace(/\/+$/, "");
  if (subtypeRaw) return `${typeRaw}/${subtypeRaw}`.replace(/\/+$/, "");
  return typeRaw.replace(/\/+$/, "");
}

function filenameForPart(part: BodyStructurePart): string | null {
  if (part.disposition && typeof part.disposition === "object") {
    const filename = part.disposition.params?.filename;
    if (filename) return filename;
  }
  return part.dispositionParameters?.filename ?? part.parameters?.name ?? null;
}

function walkBodyStructure(
  bodyStructure: unknown,
  onLeaf: (node: BodyStructurePart) => void
): void {
  if (!bodyStructure || typeof bodyStructure !== "object") return;
  const visited = new WeakSet<object>();

  const visit = (node: BodyStructurePart, depth: number) => {
    if (depth > MAX_BODYSTRUCTURE_DEPTH) return;
    if (typeof node === "object" && node !== null) {
      if (visited.has(node)) return;
      visited.add(node);
    }
    const children = Array.isArray(node.childNodes) ? node.childNodes : [];
    if (children.length > 0) {
      for (const child of children) visit(child, depth + 1);
      return;
    }
    onLeaf(node);
  };

  if (Array.isArray(bodyStructure)) {
    for (const node of bodyStructure) visit(node as BodyStructurePart, 0);
  } else {
    visit(bodyStructure as BodyStructurePart, 0);
  }
}

export function selectBodyTextPart(
  bodyStructure: unknown,
  prefer: BodyTextFormat = "plain"
): BodyTextPartChoice | null {
  const candidates: BodyTextPartChoice[] = [];
  walkBodyStructure(bodyStructure, (node) => {
    const type = mimeType(node);
    if (type !== "text/plain" && type !== "text/html" && type !== "text/x-amp-html") return;
    const disposition = dispositionType(node);
    if (disposition && disposition !== "inline") return;

    candidates.push({
      part: node.part?.toString().trim() || "TEXT",
      format: type === "text/plain" ? "plain" : "html"
    });
  });

  const plain = candidates.find((candidate) => candidate.format === "plain");
  const html = candidates.find((candidate) => candidate.format === "html");
  return prefer === "html" ? html ?? plain ?? null : plain ?? html ?? null;
}

export function extractAttachmentMetadata(bodyStructure: unknown): AttachmentMetadata[] {
  const attachments: AttachmentMetadata[] = [];
  walkBodyStructure(bodyStructure, (node) => {
    const partNumber = node.part?.toString().trim();
    if (!partNumber) return;

    const disposition = dispositionType(node);
    const filename = filenameForPart(node);
    const contentId = node.id ?? null;
    const type = mimeType(node);
    const isInlineAttachment = disposition === "inline" && Boolean(filename || contentId);
    const isExplicitAttachment = disposition === "attachment";
    const isTextBody = (type === "text/plain" || type === "text/html") && !disposition;

    if ((isExplicitAttachment || isInlineAttachment) && !isTextBody) {
      attachments.push({
        filename,
        mimeType: type || null,
        sizeBytes: typeof node.size === "number" ? node.size : null,
        disposition: isInlineAttachment ? "inline" : "attachment",
        contentId,
        partNumber
      });
    }
  });
  return attachments;
}

function decodeHtmlEntities(input: string): string {
  const named: Record<string, string> = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'"
  };

  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, raw) => {
    const token = String(raw);
    if (token.startsWith("#x") || token.startsWith("#X")) {
      return codePointToString(Number.parseInt(token.slice(2), 16)) ?? match;
    }
    if (token.startsWith("#")) {
      return codePointToString(Number.parseInt(token.slice(1), 10)) ?? match;
    }
    return named[token.toLowerCase()] ?? match;
  });
}

function codePointToString(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  // Reject anything outside Unicode (> 0x10FFFF) and the surrogate halves
  // (0xD800-0xDFFF). String.fromCodePoint throws RangeError on the first
  // and emits invalid UTF-16 on the second — both break downstream JSON.
  if (value < 0 || value > 0x10FFFF) return null;
  if (value >= 0xD800 && value <= 0xDFFF) return null;
  return String.fromCodePoint(value);
}

export function normalizeBodyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToText(html: string): string {
  return normalizeBodyText(
    decodeHtmlEntities(
      html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|h[1-6])\s*>/gi, "\n")
        .replace(/<(p|div|li|h[1-6])\b[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

export async function parseRawMime(rawMime: Buffer): Promise<{
  bodyText: string | null;
  bodyHtml: string | null;
  bodyPlain: string | null;
  headersJson: Record<string, unknown>;
  parserWarnings: string[];
}> {
  const parserWarnings: string[] = [];
  const parsed = await simpleParser(rawMime, {
    skipImageLinks: true,
    skipTextLinks: true,
    skipHtmlToText: true,
    skipTextToHtml: true,
    maxHtmlLengthToParse: MAX_HTML_PARSE_BYTES
  } as Parameters<typeof simpleParser>[1]);
  const headersJson: Record<string, unknown> = {};

  for (const [key, value] of parsed.headers) {
    if (Array.isArray(value)) {
      headersJson[key] = value.map((entry) => String(entry));
    } else if (value instanceof Date) {
      headersJson[key] = value.toISOString();
    } else {
      headersJson[key] = value == null ? null : String(value);
    }
  }

  const bodyPlain = parsed.text ? normalizeBodyText(parsed.text) : null;
  let bodyHtml: string | null = typeof parsed.html === "string" ? parsed.html : null;
  if (bodyHtml && bodyHtml.length > MAX_HTML_PARSE_BYTES) {
    parserWarnings.push("html_truncated_for_text_extraction");
    bodyHtml = bodyHtml.slice(0, MAX_HTML_PARSE_BYTES);
  }
  const bodyText = bodyPlain ?? (bodyHtml ? htmlToText(bodyHtml) : null);

  return {
    bodyText,
    bodyHtml,
    bodyPlain,
    headersJson,
    parserWarnings
  };
}
