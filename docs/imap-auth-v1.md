# IMAP Auth V1

SupaMail v1 supports username/password or provider app-password IMAP authentication only. OAuth for Gmail and Microsoft is deferred.

The core API and CLI accept:

- IMAP host
- port
- TLS/secure flag
- username
- password or app password
- provider profile

## First-Class V1 Providers

- Generic IMAP: user supplies host, port, username, and password.
- Rackspace: username/password IMAP.
- Fastmail: app password.
- iCloud Mail: app-specific password.
- Yahoo/AOL: app password where available.

Gmail app passwords can be documented as best-effort only for accounts that still support them. Gmail OAuth and Microsoft OAuth should be added as explicit future provider work, not folded into the generic IMAP password path.

## Hosted Boundary

The hosted SaaS may collect IMAP credentials or app passwords during onboarding, but the public core only stores encrypted credentials in the mirror database. Hosted OAuth tokens for Supabase project access are a control-plane concern and must not be stored in public mirror tables.
