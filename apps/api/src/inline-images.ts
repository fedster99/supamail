import { InvalidInputError } from "./errors.js";
import type { SendRequest } from "./types.js";

/** Bare, case-sensitive Content-ID. Angle brackets belong only in the MIME header. */
const CONTENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,254}$/;

export function bareContentId(value: string): string {
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}

/** CID URLs may percent-encode the identifier (RFC 2392). Never rewrite authored HTML. */
export function referencedContentIds(html: string | undefined): Set<string> {
  const ids = new Set<string>();
  for (const match of (html ?? "").matchAll(/(?:\b(?:src|href|background)\s*=\s*["']?|url\(\s*["']?)cid:([^\s"'<>)}]*)/gi)) {
    let id: string;
    try { id = decodeURIComponent(match[1]); }
    catch { throw new InvalidInputError("Malformed cid URL in HTML."); }
    if (!CONTENT_ID_PATTERN.test(id)) throw new InvalidInputError("Malformed cid URL in HTML.");
    ids.add(id);
  }
  return ids;
}

/** Validate the complete set after upload/reference resolution and reply composition. */
export function validateInlineImages(request: Pick<SendRequest, "body" | "attachments">): void {
  const ids = new Set<string>();
  const html = request.body.html ?? (request.body.format === "html" ? request.body.text : undefined);
  for (const attachment of request.attachments ?? []) {
    if (attachment.cid === undefined) {
      // Non-image inline parts remain supported by the core API.
      continue;
    }
    if (!CONTENT_ID_PATTERN.test(attachment.cid)) {
      throw new InvalidInputError("Content-ID must be a bare identifier of 1 to 255 letters, digits, dot, underscore, @, + or -.");
    }
    if (ids.has(attachment.cid)) throw new InvalidInputError("Duplicate Content-ID in attachments.");
    // MailComposer already infers these types by extension for CLI/base64 callers.
    const extension = attachment.filename.split(".").pop()?.toLowerCase();
    const inferredType = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
    if (attachment.inline === false || !/^image\/(png|jpeg|gif|webp)$/i.test(attachment.contentType ?? inferredType)) {
      throw new InvalidInputError("CID images require inline disposition and image/png, image/jpeg, image/gif or image/webp (declare contentType or use its filename extension).");
    }
    if (!html || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.content) || attachment.content.length === 0) {
      throw new InvalidInputError("CID images require an HTML body and non-empty image bytes.");
    }
    ids.add(attachment.cid);
  }
  for (const id of referencedContentIds(html)) {
    if (!ids.has(id)) throw new InvalidInputError("An HTML cid reference has no matching inline attachment.");
  }
}
