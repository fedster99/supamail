import { simpleParser } from "mailparser";
import type { AttachmentMetadata } from "./types.js";

type BodyTextFormat = "plain" | "html";

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

export function selectBodyTextPart(
  bodyStructure: unknown,
  prefer: BodyTextFormat = "plain"
): BodyTextPartChoice | null {
  if (!bodyStructure || typeof bodyStructure !== "object") return null;
  const candidates: BodyTextPartChoice[] = [];

  const visit = (node: BodyStructurePart) => {
    const children = Array.isArray(node.childNodes) ? node.childNodes : [];
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }

    const type = mimeType(node);
    if (type !== "text/plain" && type !== "text/html" && type !== "text/x-amp-html") return;
    const disposition = dispositionType(node);
    if (disposition && disposition !== "inline") return;

    candidates.push({
      part: node.part?.toString().trim() || "TEXT",
      format: type === "text/plain" ? "plain" : "html"
    });
  };

  if (Array.isArray(bodyStructure)) {
    for (const node of bodyStructure) visit(node as BodyStructurePart);
  } else {
    visit(bodyStructure as BodyStructurePart);
  }

  const plain = candidates.find((candidate) => candidate.format === "plain");
  const html = candidates.find((candidate) => candidate.format === "html");
  return prefer === "html" ? html ?? plain ?? null : plain ?? html ?? null;
}

export function extractAttachmentMetadata(bodyStructure: unknown): AttachmentMetadata[] {
  if (!bodyStructure || typeof bodyStructure !== "object") return [];
  const attachments: AttachmentMetadata[] = [];

  const visit = (node: BodyStructurePart) => {
    const children = Array.isArray(node.childNodes) ? node.childNodes : [];
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }

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
  };

  if (Array.isArray(bodyStructure)) {
    for (const node of bodyStructure) visit(node as BodyStructurePart);
  } else {
    visit(bodyStructure as BodyStructurePart);
  }

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
      const value = Number.parseInt(token.slice(2), 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    if (token.startsWith("#")) {
      const value = Number.parseInt(token.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return named[token.toLowerCase()] ?? match;
  });
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
  const parsed = await simpleParser(rawMime);
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
  const bodyHtml = typeof parsed.html === "string" ? parsed.html : null;
  const bodyText = bodyPlain ?? (bodyHtml ? htmlToText(bodyHtml) : null);

  return {
    bodyText,
    bodyHtml,
    bodyPlain,
    headersJson,
    parserWarnings: []
  };
}
