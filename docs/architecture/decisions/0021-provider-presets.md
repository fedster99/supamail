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
  - Zoho (US datacenter) — IMAP `imap.zoho.com:993` / SMTP `smtp.zoho.com:465`.
  - iCloud — IMAP `imap.mail.me.com:993` / SMTP `smtp.mail.me.com:587`
    (STARTTLS, `secure=false`).
  - Yahoo — IMAP `imap.mail.yahoo.com:993` / SMTP `smtp.mail.yahoo.com:465`.

  These are the providers' published, stable single-host coordinates — not
  guesses. iCloud and Yahoo require an app-specific password (the primary
  password is rejected over IMAP/SMTP); that is a credential concern for the
  caller, not encoded here. iCloud additionally expects the bare local-part
  (e.g. `alice`) as the IMAP username while SMTP expects the full address
  (`alice@icloud.com`) — also a caller credential concern, not encoded in the
  coordinates.

- **Zoho is multi-datacenter, so it is NOT autodiscovered.** Zoho serves several
  regional datacenters (US, EU `.eu`, IN `.in`, AU `.com.au`, CN `.zoho.com.cn`),
  and the email domain (`@zoho.com`) does not reveal which DC an account lives in.
  The `zoho` preset's `imap.zoho.com`/`smtp.zoho.com` coordinates are correct only
  for US-DC accounts, so `zoho.com`/`zohomail.com` are deliberately **absent** from
  the domain map — `@zoho.com` does not auto-resolve. US-DC users select the preset
  explicitly with `--profile zoho`; EU/IN/AU/CN users pass explicit
  `--host`/`--smtp-host` for their region's hosts. The preset is still registered
  and reachable; only domain autodiscovery is withheld.
- **A new `imapDefaults` hook on `ProviderProfile`** (`{ host, port, secure }`),
  mirroring the existing `smtpDefaults` shape. It is a fixed host string (these
  are shared access hosts, independent of the local-part), set only on real
  presets. Generic IMAP carries neither hook (explicit-only).
- **`autodiscoverProfile(emailOrDomain)`** — a pure static-map lookup from the
  email domain to a preset, with the common aliases collapsed: `me.com` /
  `icloud.com` / `mac.com` → iCloud; `ymail.com` / `rocketmail.com` → Yahoo;
  `fastmail.fm` → Fastmail. (Zoho is intentionally not in the map — see above.)
  Returns null on no match. No MX/autoconfig probing, no new dependency.
- **Wired into `createAccount` only** (the connect path). When `host` is omitted,
  the IMAP host/port/secure and `provider_profile` are resolved in this precedence:
  (1) explicit host/port/secure (always wins); (2) an explicitly-named non-generic
  preset's `imapDefaults` — `--profile fastmail` (or `--profile zoho`) supplies that
  preset's coordinates even without a domain match, so an explicit `--profile` beats
  the domain guess; (3) email-domain `autodiscoverProfile`; (4) a clear error. The
  preset fills only blanks — an explicit host/port/secure/providerProfile is never
  overridden — and the chosen preset id is stored in `provider_profile`. An unknown
  domain with no explicit host and no preset is rejected — generic IMAP stays
  explicit-only. SMTP defaults then resolve through the *unchanged* `resolveSmtpCreds`
  order, since the stored `provider_profile` is the preset id. `CREATE_ACCOUNT_SCHEMA`
  makes host/port optional; the CLI `--host/--port/--profile` become optional too.

  > Now shared (arch #41): this four-level precedence is extracted from `createAccount`
  > into a pure `resolveImapCoords(input) → {host,port,secure,providerProfile}`
  > (repository.ts), the twin of `resolveSmtpCreds`, tested by direct call. Behavior
  > and the thrown "No IMAP host/port" error are unchanged.

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
  aliases, case-insensitivity, bare domain, and unknown → null. `@zoho.com` /
  `@zohomail.com` autodiscover to null (multi-DC, not domain-resolvable) while the
  `zoho` preset still resolves its US-DC coordinates by id.
- `smtp-creds.test.ts` — each preset's `smtpDefaults` resolve through
  `resolveSmtpCreds`; the existing rackspace defaults still resolve; explicit
  `smtp_host` overrides the preset; generic with no host errors.
- `create-account-autodiscovery.test.ts` — host-less create fills coordinates +
  profile from the domain; an explicit `--profile` (e.g. fastmail, or zoho for the
  US DC) supplies the preset coordinates with no domain match; explicit host wins
  over `--profile`; unknown domain with no host/preset is rejected.
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
