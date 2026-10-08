import { Parser } from "htmlparser2";
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
  const addUrl = (value: string) => {
    const url = value.trim();
    if (!/^cid:/i.test(url)) return;
    let id: string;
    try { id = decodeURIComponent(url.slice(4)); }
    catch { throw new InvalidInputError("Malformed cid URL in HTML."); }
    if (!CONTENT_ID_PATTERN.test(id)) throw new InvalidInputError("Malformed cid URL in HTML.");
    ids.add(id);
  };
  const addStyle = (css: string) => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of withoutComments.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
      addUrl(match[1] ?? match[2] ?? match[3]);
    }
  };
  let style: string | undefined;
  const parser = new Parser({
    onopentag(name, attributes) {
      for (const attribute of ["src", "href", "background"]) {
        if (attributes[attribute] !== undefined) addUrl(attributes[attribute]);
      }
      if (attributes.style !== undefined) addStyle(attributes.style);
      if (name === "style") style = "";
    },
    ontext(text) { if (style !== undefined) style += text; },
    onclosetag(name) {
      if (name === "style" && style !== undefined) {
        addStyle(style);
        style = undefined;
      }
    }
  });
  // The parser decodes attribute entities and ignores comments/prose. Inspection
  // only: the authored HTML is passed unchanged to the MIME composer.
  parser.end(html ?? "");
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
    // A repeated four-character group can overflow V8's regexp stack on valid
    // multi-megabyte uploads. A flat character class keeps validation stack-safe.
    if (!html || attachment.content.length === 0 || attachment.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.content)) {
      throw new InvalidInputError("CID images require an HTML body and non-empty image bytes.");
    }
    ids.add(attachment.cid);
  }
  for (const id of referencedContentIds(html)) {
    if (!ids.has(id)) throw new InvalidInputError("An HTML cid reference has no matching inline attachment.");
  }
}
