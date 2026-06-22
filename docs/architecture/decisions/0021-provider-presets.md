# ADR 0021: Provider IMAP/SMTP Presets + Email-Domain Autodiscovery

Status: Accepted

Date: 2026-06-22

## Context

Connecting a mailbox today requires the operator to type the IMAP host/port and
(for send) the SMTP host/port/secure by hand. That is fine for the self-hosted
generic case, but it is friction for the IMAP long tail — Fastmail, Zoho,
iCloud, Yahoo — whose coordinates are stable, published, and well-known. ADR
0013 already says provider-specific behavior must live on `ProviderProfile`s, not
scattered conditionals, and ADR 0017 already added the `smtpDefaults` hook on
`ProviderProfile` (set only for the real `rackspace` mapping) consumed by
`resolveSmtpCreds` in resolution order explicit columns → profile defaults →
error.

The missing piece is two-fold: (1) the long-tail providers have no preset at
all, and (2) nothing maps an email *domain* to a preset, so even a known
provider still needs manual coordinates.

This is a connectivity-config decision (which coordinates, picked how), distinct
from ADR 0013's compatibility-*contract* decision (what "generic IMAP support"
means and how it is proven). They are kept as separate ADRs so the contract ADR
stays about validation lanes and this one stays about onboarding ergonomics.

## Decision

Add a small static preset table plus a pure domain lookup. No network probing.

- **Four long-tail presets as `ProviderProfile`s**, each inheriting
  `genericImapProfile` (no known sync quirks) and carrying BOTH coordinate sets:
  - Fastmail — IMAP `imap.fastmail.com:993` (implicit TLS) / SMTP
    `smtp.fastmail.com:465` (implicit TLS).
  - Zoho — IMAP `imap.zoho.com:993` / SMTP `smtp.zoho.com:465`.
  - iCloud — IMAP `imap.mail.me.com:993` / SMTP `smtp.mail.me.com:587`
    (STARTTLS, `secure=false`).
  - Yahoo — IMAP `imap.mail.yahoo.com:993` / SMTP `smtp.mail.yahoo.com:465`.

  These are the providers' published, stable single-host coordinates — not
  guesses. iCloud and Yahoo require an app-specific password (the primary
  password is rejected over IMAP/SMTP); that is a credential concern for the
  caller, not encoded here.
- **A new `imapDefaults` hook on `ProviderProfile`** (`{ host, port, secure }`),
  mirroring the existing `smtpDefaults` shape. It is a fixed host string (these
  are shared access hosts, independent of the local-part), set only on real
  presets. Generic IMAP carries neither hook (explicit-only).
- **`autodiscoverProfile(emailOrDomain)`** — a pure static-map lookup from the
  email domain to a preset, with the common aliases collapsed: `me.com` /
  `icloud.com` / `mac.com` → iCloud; `ymail.com` / `rocketmail.com` → Yahoo;
  `fastmail.fm` → Fastmail; `zohomail.com` → Zoho. Returns null on no match. No
  MX/autoconfig probing, no new dependency.
- **Wired into `createAccount` only** (the connect path). When `host` is omitted,
  the IMAP host/port/secure and `provider_profile` are filled from the
  autodiscovered preset; **explicit input always wins** (an explicit
  host/port/secure/providerProfile is never overridden, and the preset fills only
  blanks). An unknown domain with no explicit host is rejected with a clear
  error — generic IMAP stays explicit-only. SMTP defaults then resolve through
  the *unchanged* `resolveSmtpCreds` order, since autodiscovery sets
  `provider_profile` to the preset id. `CREATE_ACCOUNT_SCHEMA` makes host/port
  optional; the CLI `--host/--port/--profile` become optional too.

This is connectivity config only: no new MCP tool, no write verb, nothing under
`src/mcp/`. The frozen crypto/envelope (ADR 0002) and the `resolveSmtpCreds`
resolution-order contract (ADR 0017) are untouched.

## Consequences

- Connecting a Fastmail/Zoho/iCloud/Yahoo mailbox needs only email + username +
  password — coordinates are inferred. The self-hosted generic path is unchanged
  (explicit coordinates required).
- The preset table is the maintenance surface: a provider that changes a host (or
  a new long-tail provider) is a one-line table edit plus a domain-alias entry,
  not engine code.
- The cloud onboarding UX, credential-lifecycle (app-password capture),
  multi-mailbox, and JMAP parts of email-008 are out of scope here and live in
  the cloud repo; this OSS layer only supplies the preset coordinates + domain
  lookup the cloud consumes via re-pin.

## Verification

- `provider-profiles.test.ts` — each preset resolves the exact IMAP + SMTP
  coordinates; all four register alongside rackspace + generic; generic carries
  no defaults; domain autodiscovery incl. icloud/me/mac and yahoo/ymail/rocketmail
  aliases, case-insensitivity, bare domain, and unknown → null.
- `smtp-creds.test.ts` — each preset's `smtpDefaults` resolve through
  `resolveSmtpCreds`; the existing rackspace defaults still resolve; explicit
  `smtp_host` overrides the preset; generic with no host errors.
- `create-account-autodiscovery.test.ts` — host-less create fills coordinates +
  profile from the domain; explicit host/profile wins; unknown domain with no
  host is rejected.
- `api-safety.test.ts` — POST /accounts accepts a body without host/port.
- `agent-surface-zero-send.test.ts` + `sync-adapter-read-only.test.ts` stay green
  and unchanged (no `src/mcp/` change, no new write verb).

## References

- ADR 0002: Node-side credential encryption (the frozen envelope, untouched).
- ADR 0013: IMAP compatibility contract (provider behavior lives on profiles).
- ADR 0017: Send primitive (the `smtpDefaults` hook + `resolveSmtpCreds` order
  this extends).
- `apps/api/src/provider-profiles.ts`, `apps/api/src/repository.ts`,
  `apps/api/src/smtp-client.ts`, `apps/api/src/api.ts`, `apps/api/src/cli.ts`.
