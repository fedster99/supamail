# Embedded images

Sends and saved drafts use the same Nodemailer MIME composer. Supply image bytes
and a bare, case-sensitive `cid`, then reference it from HTML:

```json
{
  "accountId": "11111111-1111-4111-8111-111111111111",
  "to": [{ "email": "recipient@example.test" }],
  "subject": "Hello",
  "body": { "format": "html", "html": "<p>Best, Alex</p><img src=\"cid:logo@example.test\" width=\"56\" height=\"52\">" },
  "attachments": [{
    "filename": "logo.png",
    "contentType": "image/png",
    "content": "<base64-encoded PNG bytes>",
    "cid": "logo@example.test",
    "inline": true
  }]
}
```

`content` is bytes transported as base64; this alone does not mean MIME-inline.
`cid` implies inline disposition. A CID image requires PNG, JPEG, GIF or WebP
content type (or the corresponding filename extension when omitted), nonempty
base64 bytes and an HTML body. IDs are 1–255 characters, start with a letter or
digit, and contain only letters, digits, dot, underscore, `@`, `+`, or `-`.
Angle brackets and the `cid:` prefix are not part of the input ID. Duplicate IDs,
`inline:false` with a CID, malformed CID URLs and missing referenced images
raise `InvalidInputError` before SMTP submission or draft APPEND.

MailComposer places images under `multipart/related` with the HTML; ordinary
attachments remain ordinary attachments in the surrounding `multipart/mixed`.
No remote URL is fetched or rewritten. Content types are declared or inferred;
this is not image transcoding or a promise that arbitrary bytes decode as an image.
Recipient software and security policies can still hide embedded images.

`createDraft` and `updateDraft` accept the same attachment shape. An update is a
complete replacement: include every file and inline image that must remain, with
its original CID, along with the replacement body and threading headers.
`sendDraft` sends the saved raw MIME, so it needs no image download or reconstruction.

`read_message` includes `content_id` (bare, or null) with each attachment's ID and
disposition. Protected metadata follows the existing attachment reveal path.
`read_thread` continues to omit inline parts; read the individual message to get them.
An existing nonconforming CID can be assigned a new supported ID if the caller
also changes every corresponding HTML reference.

For HTML `draft_reply`, quoted source HTML is retained. Its `attachments` output
contains `{attachmentId, cid, inline:true}` references for images used by the
quote. A host resolves them through the existing authorized attachment download
path, combines them with authored images and files, and calls `sendMessage` or
`createDraft`. Use different IDs for newly authored images; collisions fail
instead of silently associating an image with the wrong bytes. Plain replies
keep the existing text-based quote.
