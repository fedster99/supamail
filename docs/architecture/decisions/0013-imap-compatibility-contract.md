# ADR 0013: IMAP Compatibility Contract

Status: Accepted

Date: 2026-05-24

## Context

SupaMail should not claim broad IMAP support because it works against one or two servers. IMAP providers vary in folder listing, delimiters, `SPECIAL-USE` flags, UID search behavior, MIME body fetches, throttling, UIDVALIDITY behavior, and error responses.

The core needs a compatibility story that is honest for users and maintainable for the sync engine.

## Decision

SupaMail defines a minimum generic IMAP contract in `docs/imap-compatibility.md` and tracks provider support in a matrix. Provider-specific behavior must live in provider profiles or small profile-driven sync hooks, not scattered conditionals throughout the engine.

Automated compatibility coverage has three lanes:

- unit tests for provider profile metadata and UID search edge cases
- live DB fixture tests for distinct provider shapes
- GreenMail smoke tests for real IMAP/SMTP protocol behavior

Live provider accounts remain manual smoke checks until safe provider-specific CI accounts exist.

## Consequences

- "Generic IMAP" means a stated protocol contract validated by provider shape, not "works with all IMAP."
- Known provider quirks must be documented in the provider matrix and represented on provider profiles when code behavior changes.
- New provider claims require either automated fixture coverage, GreenMail/protocol proof, or a recorded manual smoke result.
- The sync engine should stay provider-neutral except for profile-driven hooks such as verified Rackspace alias exclusion.

## Verification

- `docs/imap-compatibility.md` records the minimum contract, provider matrix, automated coverage, and manual smoke checklist.
- `provider-compatibility.integration.test.ts` covers Dovecot/cPanel-style and Cyrus/Rackspace-style fixtures, empty `LIST`, large raw MIME caps, and transient disconnect visibility.
- `provider-profiles.test.ts` verifies provider quirk metadata.
- `imap-client.test.ts` verifies non-contiguous UID date-search edges.
- `pnpm smoke:greenmail` verifies the real GreenMail IMAP/SMTP protocol path.

## References

- Issue #3: Build IMAP compatibility matrix and protocol validation.
- `docs/imap-compatibility.md`
- `apps/api/src/provider-profiles.ts`
- `apps/api/src/__tests__/provider-compatibility.integration.test.ts`
