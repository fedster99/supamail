# ADR 0002: Encrypt IMAP Credentials In Node

Status: Accepted

Date: 2026-05-18

## Context

The old source design used pgcrypto-style examples for credential encryption. For SupaMail, sending the master encryption key through SQL functions risks exposure in database logs, query statistics, or operational tooling.

## Decision

Encrypt IMAP passwords in Node using AES-256-GCM before persistence. Store only the encrypted payload in Postgres. Do not create SQL helper functions that accept the plaintext password or master key.

## Consequences

- The encryption key remains an application environment secret.
- Database logs and query introspection should not see plaintext passwords or the master key.
- Code that creates or uses accounts must go through the repository/crypto path instead of writing credentials directly.

## Verification

- `apps/api/src/crypto.ts` owns password encryption/decryption.
- `apps/api/src/repository.ts` encrypts in `createAccount`.
- `apps/api/src/__tests__/crypto.test.ts` covers the round trip and failure cases.

## References

- `apps/api/src/crypto.ts`
- `apps/api/src/repository.ts`
- PR #5 body notes.
