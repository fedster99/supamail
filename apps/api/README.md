
Programmatic `SendRequest` and `DraftInput` support an optional `senderName`
(single line, at most 120 characters). It changes only the MIME From display name;
the mailbox continues to determine the From address and SMTP envelope. Created
and updated drafts retain this name in their MIME, which `sendDraft` sends unchanged.
Hosts own any persisted preferences. `SENDER_NAME_SUPPORTED` advertises this
capability to library consumers.
