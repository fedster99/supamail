import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  MailParser,
  type AttachmentStream,
  type Headers,
  type MessageText
} from "mailparser";
import type { AttachmentMetadata, MessageEvidenceInput } from "./types.js";

type BodyTextFormat = "plain" | "html";

const MAX_BODYSTRUCTURE_DEPTH = 64;
const MAX_HTML_PARSE_BYTES = 1_048_576;
const MAX_EXTRACTED_EVIDENCE = 100;
const MAX_CALENDAR_EVIDENCE_BYTES = 1_048_576;
const MAX_PROVIDER_RESOURCE_SCAN_CHARS = 2_000_000;
const MAX_PROVIDER_URL_CANDIDATES = 1_000;

function boundedText(value: string | null | undefined, maxBytes: number): string | null {
  if (!value) return null;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1F || codePoint === 0x7F) continue;
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result || null;
}

function unfoldIcalendar(value: string): string[] {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
}

function icalendarProperty(line: string): { name: string; value: string } | null {
  const separator = line.indexOf(":");
  if (separator < 1) return null;
  return {
    name: line.slice(0, separator).split(";", 1)[0]!.trim().toUpperCase(),
    value: line.slice(separator + 1).trim()
  };
}

function extractCalendarEvidence(content: Buffer): {
  evidence: MessageEvidenceInput[];
  truncated: boolean;
} {
  const lines = unfoldIcalendar(content.toString("utf8"));
  const method = lines
    .map(icalendarProperty)
    .find((property) => property?.name === "METHOD")?.value.toUpperCase() ?? null;
  const evidence: MessageEvidenceInput[] = [];
  let truncated = false;
  let component: "VEVENT" | "VTODO" | null = null;
  let properties = new Map<string, string>();

  for (const line of lines) {
    const normalized = line.trim().toUpperCase();
    if (normalized === "BEGIN:VEVENT" || normalized === "BEGIN:VTODO") {
      component = normalized.slice("BEGIN:".length) as "VEVENT" | "VTODO";
      properties = new Map();
      continue;
    }
    if (normalized === "END:VEVENT" || normalized === "END:VTODO") {
      const uid = boundedText(properties.get("UID"), 1_024);
      if (component && uid) {
        const recurrenceId = boundedText(properties.get("RECURRENCE-ID"), 512);
        const rawSequence = properties.get("SEQUENCE") ?? "0";
        const sequence = /^\d{1,9}$/.test(rawSequence) ? Number(rawSequence) : 0;
        if (evidence.length >= MAX_EXTRACTED_EVIDENCE) {
          truncated = true;
        } else {
          evidence.push({
            kind: "calendar_instance",
            namespace: "icalendar",
            key: JSON.stringify([uid, recurrenceId]),
            metadata: {
              uid,
              recurrenceId,
              sequence,
              dtstamp: boundedText(properties.get("DTSTAMP"), 512),
              dtstart: boundedText(properties.get("DTSTART"), 512),
              method: boundedText(method, 64),
              component
            }
          });
        }
      }
      component = null;
      properties = new Map();
      continue;
    }
    if (!component) continue;
    const property = icalendarProperty(line);
    if (property && !properties.has(property.name)) properties.set(property.name, property.value);
  }

  return { evidence, truncated };
}

function cleanUrlCandidate(value: string): string {
  return value.replace(/[)>\],.;!?]+$/, "").slice(0, 2_048);
}

function providerResourceEvidence(value: string): {
  evidence: MessageEvidenceInput[];
  truncated: boolean;
} {
  const evidence: MessageEvidenceInput[] = [];
  const identities = new Set<string>();
  const scanValue = value.slice(0, MAX_PROVIDER_RESOURCE_SCAN_CHARS);
  let truncated = value.length > scanValue.length;
  let candidateCount = 0;
  const push = (item: MessageEvidenceInput): void => {
    const identity = `${item.kind}\u0000${item.namespace}\u0000${item.key}`;
    if (identities.has(identity)) return;
    if (evidence.length >= MAX_EXTRACTED_EVIDENCE) {
      truncated = true;
      return;
    }
    identities.add(identity);
    evidence.push(item);
  };
  for (const match of scanValue.matchAll(/https?:\/\/[^\s<>"']{1,2048}/gi)) {
    candidateCount += 1;
    if (candidateCount > MAX_PROVIDER_URL_CANDIDATES) {
      truncated = true;
      break;
    }
    let url: URL;
    try {
      url = new URL(cleanUrlCandidate(match[0]));
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");

    if (host === "github.com") {
      const item = path.match(/^\/([^/]+)\/([^/]+)\/(issues|pull)\/([1-9]\d*)$/i);
      if (item) {
        const owner = item[1]!.toLowerCase();
        const repository = item[2]!.toLowerCase();
        const resourceType = item[3]!.toLowerCase() === "pull" ? "pull" : "issue";
        const number = Number(item[4]);
        push({
          kind: "provider_resource",
          namespace: resourceType === "pull" ? "github_pull" : "github_issue",
          key: `${owner}/${repository}#${number}`,
          metadata: { provider: "github", host, owner, repository, resourceType, number }
        });
      }
      continue;
    }

    if (host === "docs.google.com" || host === "drive.google.com") {
      const item = path.match(/^\/(?:document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{10,})(?:\/|$)/)
        ?? path.match(/^\/file\/d\/([A-Za-z0-9_-]{10,})(?:\/|$)/);
      if (item) {
        push({
          kind: "provider_resource",
          namespace: "google_drive_file",
          key: item[1]!,
          metadata: { provider: "google_drive", host, resourceType: "file" }
        });
      }
      continue;
    }

    if (host.endsWith(".atlassian.net")) {
      const item = path.match(/^\/browse\/([A-Z][A-Z0-9_]*-[1-9]\d*)$/i);
      if (item) {
        const issueKey = item[1]!.toUpperCase();
        push({
          kind: "provider_resource",
          namespace: "jira_issue",
          key: `${host}/${issueKey}`,
          metadata: { provider: "jira", host, resourceType: "issue", issueKey }
        });
      }
      continue;
    }

    if (host === "app.docusign.com" || host === "app.docusign.net") {
      const envelopeId = path.match(
        /(?:^|\/)([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/|$)/i
      )?.[1];
      if (envelopeId && /\/(?:documents?|envelopes?)(?:\/|$)/i.test(path)) {
        push({
          kind: "provider_resource",
          namespace: "docusign_envelope",
          key: envelopeId.toLowerCase(),
          metadata: { provider: "docusign", host, resourceType: "envelope" }
        });
      }
    }
  }
  return { evidence, truncated };
}

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

interface StreamedAttachmentEvidence {
  checksum: string;
  contentType: string;
  filename?: string;
  contentDisposition?: string;
  contentId?: string;
  related?: boolean;
  size: number;
  calendarContent: Buffer | null;
}

type MimeSource = Buffer | AsyncIterable<Buffer | Uint8Array | string>;

interface ParsedMimeContent {
  bodyText: string | null;
  bodyHtml: string | null;
  bodyPlain: string | null;
  headersJson: Record<string, unknown>;
  parserWarnings: string[];
  evidence: MessageEvidenceInput[];
}

async function streamMimeEvidence(source: MimeSource): Promise<{
  headers: Headers;
  text: string | null;
  html: string | null;
  attachments: StreamedAttachmentEvidence[];
}> {
  return await new Promise((resolve, reject) => {
    const parser = new MailParser({
      skipImageLinks: true,
      skipTextLinks: true,
      skipHtmlToText: true,
      skipTextToHtml: true,
      maxHtmlLengthToParse: MAX_HTML_PARSE_BYTES,
      checksumAlgo: "sha256"
    });
    let headers: Headers = new Map();
    let text: string | null = null;
    let html: string | null = null;
    const attachments: StreamedAttachmentEvidence[] = [];
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      parser.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    parser.once("error", fail);
    parser.on("headers", (value) => {
      headers = value;
    });
    parser.on("data", (data: AttachmentStream | MessageText) => {
      if (data.type === "text") {
        if (typeof data.text === "string") text = data.text;
        if (typeof data.html === "string") html = data.html;
        return;
      }

      const attachment = data;
      const contentType = attachment.contentType.toLowerCase();
      const isCalendar = contentType === "text/calendar"
        || contentType === "application/ics"
        || contentType === "application/icalendar";
      const calendarChunks: Buffer[] = [];
      let calendarBytes = 0;
      attachment.content.on("data", (chunk: Buffer | string) => {
        if (!isCalendar || calendarBytes > MAX_CALENDAR_EVIDENCE_BYTES) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        calendarBytes += buffer.length;
        if (calendarBytes <= MAX_CALENDAR_EVIDENCE_BYTES) calendarChunks.push(buffer);
        else calendarChunks.length = 0;
      });
      attachment.content.once("error", fail);
      attachment.content.once("end", () => {
        attachments.push({
          checksum: attachment.checksum,
          contentType: attachment.contentType,
          filename: attachment.filename,
          contentDisposition: attachment.contentDisposition,
          contentId: attachment.contentId,
          related: attachment.related,
          size: attachment.size,
          calendarContent: isCalendar && calendarBytes <= MAX_CALENDAR_EVIDENCE_BYTES
            ? Buffer.concat(calendarChunks, calendarBytes)
            : null
        });
        attachment.release();
      });
    });
    parser.once("end", () => {
      if (settled) return;
      settled = true;
      resolve({ headers, text, html, attachments });
    });
    if (Buffer.isBuffer(source)) {
      parser.end(source);
      return;
    }

    void (async () => {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!parser.write(buffer)) await once(parser, "drain");
      }
      parser.end();
    })().catch(fail);
  });
}

async function parseRawMimeSource(source: MimeSource): Promise<ParsedMimeContent> {
  const parserWarnings: string[] = [];
  const parsed = await streamMimeEvidence(source);
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
  const evidence: MessageEvidenceInput[] = [];
  const identities = new Set<string>();
  let evidenceTruncated = false;
  const pushEvidence = (item: MessageEvidenceInput): void => {
    const identity = `${item.kind}\u0000${item.namespace}\u0000${item.key}`;
    if (identities.has(identity)) return;
    if (evidence.length >= MAX_EXTRACTED_EVIDENCE) {
      evidenceTruncated = true;
      return;
    }
    identities.add(identity);
    evidence.push(item);
  };
  for (const attachment of parsed.attachments) {
    pushEvidence({
      kind: "attachment_content",
      namespace: "sha256",
      key: attachment.checksum,
      metadata: {
        filename: boundedText(attachment.filename, 512),
        mimeType: boundedText(attachment.contentType, 255),
        sizeBytes: attachment.size,
        disposition: boundedText(attachment.contentDisposition, 64),
        contentId: boundedText(attachment.contentId, 512),
        related: attachment.related === true
      }
    });
    if (evidenceTruncated) break;
    const contentType = attachment.contentType.toLowerCase();
    if (contentType === "text/calendar" || contentType === "application/ics" || contentType === "application/icalendar") {
      if (!attachment.calendarContent) {
        evidenceTruncated = true;
        break;
      }
      const calendarResult = extractCalendarEvidence(attachment.calendarContent);
      for (const calendarEvidence of calendarResult.evidence) {
        pushEvidence(calendarEvidence);
      }
      if (calendarResult.truncated) evidenceTruncated = true;
    }
  }
  if (!evidenceTruncated) {
    const resourceResult = providerResourceEvidence([bodyPlain, bodyHtml].filter(Boolean).join("\n"));
    for (const resourceEvidence of resourceResult.evidence) {
      pushEvidence(resourceEvidence);
    }
    if (resourceResult.truncated) evidenceTruncated = true;
  }
  if (evidenceTruncated) {
    parserWarnings.push("artifact_evidence_truncated");
  }

  return {
    bodyText,
    bodyHtml,
    bodyPlain,
    headersJson,
    parserWarnings,
    evidence
  };
}

export async function parseRawMime(rawMime: Buffer): Promise<ParsedMimeContent> {
  return await parseRawMimeSource(rawMime);
}

export async function parseRawMimeStream(
  source: AsyncIterable<Buffer | Uint8Array | string>
): Promise<ParsedMimeContent & { rawBytes: number; rawMimeSha256: string }> {
  const hash = createHash("sha256");
  let rawBytes = 0;
  async function* tracked(): AsyncIterable<Buffer> {
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      rawBytes += buffer.length;
      hash.update(buffer);
      yield buffer;
    }
  }

  const parsed = await parseRawMimeSource(tracked());
  return {
    ...parsed,
    rawBytes,
    rawMimeSha256: hash.digest("hex")
  };
}
