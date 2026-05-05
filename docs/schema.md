# Schema Overview

The mirror owns these neutral tables in `public`:

- `imap_accounts`
- `imap_folders`
- `imap_messages`
- `imap_message_bodies`
- `imap_attachments`
- `imap_sync_runs`
- `imap_sync_events`

RLS is enabled on all mirror tables and `anon`/`authenticated` access is revoked when those Supabase roles exist. The worker/API should use a direct Postgres connection string, not the browser-facing Supabase Data API.

`imap_messages` stays metadata-oriented so list queries remain small. Full body data lives in `imap_message_bodies`.

`imap_message_bodies.raw_mime` stores RFC822/MIME bytes. Parsed fields store plain text, HTML, normalized text, parsed headers, selected text part, parser warnings, and MIME structure snapshots.

Messages are soft-deleted when reconciliation, folder disappearance, UIDVALIDITY resets, or provider deletion indicate they are no longer visible.
