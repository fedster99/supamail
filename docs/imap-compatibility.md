# IMAP Compatibility

SupaMail is a generic IMAP mirror, but it does not claim that every IMAP provider works automatically. IMAP servers differ in folder listing, delimiters, `SPECIAL-USE` flags, UID search behavior, body fetch limits, MIME structures, timeouts, and error responses. Compatibility is tracked provider by provider.

## Minimum Contract

An IMAP account is compatible with SupaMail when it supports these behaviors reliably:

- Authenticate with username/password or provider app password over TLS, or on a trusted local test host.
- `LIST` returns stable mailbox names and delimiters. Empty `LIST` responses are treated as provider errors, not deletion authority.
- `SELECT` exposes `UIDVALIDITY`, `UIDNEXT`, and message counts for each mailbox.
- UID-scoped `SEARCH` or `FETCH` supports all messages, date-bounded live-window searches, date-bounded historical searches, and UID ranges.
- UID-scoped metadata fetch returns the requested UIDs, flags, `INTERNALDATE`, size, envelope, headers, and `BODYSTRUCTURE`.
- UID-scoped raw body fetch can return RFC822/MIME source with a byte cap.
- Flags are stable enough to compare as normalized sets.
- Transient disconnects and mailbox errors are surfaced as account/folder health, not silently skipped.

If a server lacks one of these behaviors, support needs either a provider profile quirk or an explicit unsupported note in the matrix.

## Provider Matrix

| Provider / shape | Status | Automated coverage | Known quirks / notes |
| --- | --- | --- | --- |
| Generic IMAP core | Supported contract | Unit and integration fixtures cover folder discovery, UID searches, metadata fetches, body fetches, reconcile, and health. | This is a protocol contract, not a promise about every provider. |
| GreenMail | Automated smoke | `pnpm smoke:greenmail` runs against `greenmail/standalone` through real IMAP/SMTP. | Smoke is Docker/local because it starts a server container. |
| Dovecot | Automated smoke | `pnpm smoke:dovecot` runs against `dovecot/dovecot` through the real IMAP protocol with seeded Maildir folders. | Smoke is Docker/local because it starts a server container. |
| Dovecot/cPanel-style IMAP | Automated smoke + fixture validated | `pnpm smoke:dovecot` covers real Dovecot folder listing, UID search, body fetch, attachment metadata, Archive tracking, and Trash exclusion. `provider-compatibility.integration.test.ts` covers no `SPECIAL-USE` flags, slash delimiters, and name-based noisy-folder exclusion. | Use `generic-imap` profile unless a live provider proves a quirk. |
| Cyrus/Rackspace-style IMAP | Fixture validated | `provider-compatibility.integration.test.ts` covers dot delimiters and the Rackspace `INBOX.INBOX` alias path. | `rackspace` profile excludes `INBOX.INBOX` only after metadata fingerprint verification. |
| Rackspace Email | Profiled, live smoke pending | Profile and alias tests exist. | Use app password/IMAP password. Live smoke should verify folder aliases and UID search behavior before claiming full support. |
| Fastmail | Connectivity preset; live smoke pending | `provider-profiles.test.ts` covers the `fastmail` preset coordinates + domain autodiscovery. | `fastmail` preset (IMAP `imap.fastmail.com:993` / SMTP `smtp.fastmail.com:465`) autodiscovered from `fastmail.com`/`fastmail.fm`; sync behavior is generic-core (ADR 0021). Verify special-use folders and archive behavior on a live smoke. |
| Zoho Mail (US DC) | Connectivity preset (explicit `--profile zoho` only); live smoke pending | `provider-profiles.test.ts` covers the `zoho` preset coordinates and that `@zoho.com` is NOT autodiscovered. | `zoho` preset (IMAP `imap.zoho.com:993` / SMTP `smtp.zoho.com:465`) is US-DC only and is NOT domain-autodiscovered: Zoho is multi-datacenter (US/EU/IN/AU/CN) and the domain can't reveal the DC. US users select `--profile zoho`; EU/IN/AU/CN users pass explicit `--host`/`--smtp-host` (`.eu`/`.in`/`.com.au`/`.zoho.com.cn`). Sync behavior is generic-core (ADR 0021). |
| iCloud Mail | Connectivity preset; live smoke pending | `provider-profiles.test.ts` covers the `icloud` preset coordinates + domain autodiscovery. | `icloud` preset (IMAP `imap.mail.me.com:993` / SMTP `smtp.mail.me.com:587` STARTTLS) autodiscovered from `icloud.com`/`me.com`/`mac.com`; requires an app-specific password (ADR 0021). Verify folder names and throttling. |
| Yahoo Mail | Connectivity preset; live smoke pending | `provider-profiles.test.ts` covers the `yahoo` preset coordinates + domain autodiscovery. | `yahoo` preset (IMAP `imap.mail.yahoo.com:993` / SMTP `smtp.mail.yahoo.com:465`) autodiscovered from `yahoo.com`/`ymail.com`/`rocketmail.com`; requires an app password (ADR 0021). AOL is out of scope (different hosts, not mapped). Verify throttling and transient disconnect behavior. |
| Gmail IMAP | Manual smoke pending | None yet. | Gmail `All Mail` must stay excluded by profile; OAuth is outside v0.1. |
| Outlook IMAP | Manual smoke pending | None yet. | OAuth is outside v0.1; app-password/basic auth availability depends on tenant policy. |
| Generic Dovecot hosting | Manual smoke pending | Dovecot/cPanel-style fixture exists. | Verify delimiter, namespace prefix, and missing `SPECIAL-USE` flags on the actual host. |

## Automated Coverage

The compatibility gate is split by cost:

- `pnpm test` runs unit compatibility checks, including provider profile quirk metadata and UID search edge cases.
- `pnpm test:db:live` runs `provider-compatibility.integration.test.ts` against disposable Postgres with deterministic IMAP fixtures.
- `pnpm smoke:greenmail` starts a real GreenMail container and syncs through the real IMAP/SMTP protocol.
- `pnpm smoke:dovecot` starts a real Dovecot container and syncs through the real IMAP protocol against seeded Maildir data.

The live DB fixture suite currently covers:

- servers without `SPECIAL-USE` flags
- slash and dot folder delimiters
- empty folder-list failures that must not tombstone mail
- large raw MIME body byte caps
- transient disconnects becoming visible health state

The real-server smoke suite currently covers:

- GreenMail SMTP delivery into IMAP followed by mirror sync
- Dovecot Maildir folder discovery without `SPECIAL-USE`
- Dovecot slash delimiters, UID search, raw body fetch, and attachment metadata
- Dovecot Archive folders staying trackable while Trash stays provider-excluded

## Manual Smoke Checklist

Use this checklist before moving a provider from "manual smoke pending" to "validated":

1. Create a disposable mailbox or test account with at least one message in `INBOX`, one sent-like folder, one archive-like folder, and one noisy folder such as Trash/Junk.
2. Add the account with the narrowest profile that matches the provider, usually `generic-imap`.
3. Run one manual sync and confirm folder discovery records the provider delimiter, noisy folders are excluded, and Archive-like folders remain trackable.
4. Confirm initial sync stores headers for expected folders and does not mirror excluded folders.
5. Enable immediate body fetch for the test account and confirm raw MIME (with the default `BODY_STORAGE_MODE=raw_mime`), parsed body text, HTML/plain fields, and attachment metadata are stored.
6. Trigger a second sync after adding and deleting test messages provider-side; confirm incremental sync, flag changes, and reconcile results are visible.
7. Force or simulate a transient provider failure if practical; confirm account/folder health records the failure.
8. Record the result in this matrix and add a provider-profile quirk only if code needs provider-specific behavior.

Do not add provider conditionals directly to the sync engine unless the quirk cannot be represented by a provider profile or a small profile-driven hook.
