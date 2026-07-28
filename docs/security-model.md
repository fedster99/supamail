# Security and Privacy Model

Last reviewed: 2026-07-28

This document explains which SupaMail data is encrypted, where keys live, what
an attacker can still learn, and which claims the public repository can prove.
It covers both self-hosted SupaMail OSS and the hosted SupaMail Cloud product.

## Short version

- SupaMail encrypts mailbox passwords in the application before they enter
  Postgres.
- Hosted SupaMail Cloud also encrypts complete body objects before they enter
  Supabase Storage.
- The hosted body key is separate from credential and control-plane keys.
- Hosted API and MCP bearer tokens are stored as hashes, not plaintext.
- SupaMail-owned provider keys are runtime secrets. Persisted customer BYO
  credentials are encrypted before they enter the control-plane database.
- No real key value is committed to this repository or exposed to the browser.
- Message headers, mailbox metadata, and hosted search representations are not
  end-to-end encrypted.
- SupaMail Cloud is not zero knowledge. The hosted runtime must process
  plaintext to sync, search, and serve email.

## Product boundaries

| Data | Self-hosted OSS | Hosted SupaMail Cloud |
| --- | --- | --- |
| IMAP and SMTP passwords | AES-256-GCM before Postgres | Same application envelope |
| Complete message bodies | Stored in the operator's Postgres database by default | AES-256-GCM before private Supabase Storage |
| Message headers and metadata | Readable in Postgres | Readable in the tenant-scoped mirror |
| Search representation | Readable in Postgres | Readable to the runtime and hosted search provider |
| API and MCP bearer tokens | Operator-managed runtime secret | Only a SHA-256 hash and short display prefix are stored |
| Provider and infrastructure keys | Operator-managed runtime secrets | Vercel or Fly runtime secrets |

Self-hosting gives the operator full control and full responsibility. Anyone
with sufficient access to the self-hosted database can read mirrored message
content. SupaMail OSS does not currently add application-layer encryption to
the default `DatabaseBodyStore`.

## Threat model

The hosted design reduces the effect of isolated infrastructure leaks:

| Compromise | Expected result |
| --- | --- |
| Control-plane or mirror database dump | Complete Storage body objects remain encrypted, but headers, metadata, pointers, and other documented database fields are visible. |
| Supabase Storage object or Storage server credential | Complete body content remains unreadable without the separate body-encryption key. |
| Body-encryption key alone | It is not enough without the encrypted objects and their authenticated Tenant, message, and checksum context. |
| Body-encryption root plus Storage access | Complete hosted body objects within that root's scope can be decrypted. Treat the root as a high-value production secret. |
| One derived Tenant key | It cannot decrypt another Tenant's body objects. |
| API or MCP token database row | A generated high-entropy plaintext bearer token is not recoverable from its stored SHA-256 hash. |
| Production runtime or secret-manager compromise | The attacker can obtain keys or observe plaintext. Application-layer encryption does not protect this boundary. |
| Privileged hosted operator | A sufficiently privileged operator can deploy code that observes plaintext. SupaMail Cloud is not zero knowledge. |

Encryption is one control. Tenant-scoped rows, row-level security, private
Storage buckets, forced account filters, content-bound object paths, and
tenant-specific search namespaces remain separate controls.

## Credential protection

The public implementation is in
[`apps/api/src/crypto.ts`](../apps/api/src/crypto.ts) and its tests.

1. Node derives a 32-byte key by hashing `IMAP_ENCRYPTION_KEY` with SHA-256.
2. It creates a fresh random 12-byte IV.
3. It encrypts the password with AES-256-GCM.
4. Postgres receives only
   `version || IV || authentication tag || ciphertext`.
5. Decryption rejects malformed payloads, unknown versions, wrong keys, and
   modified ciphertext.

The master key and plaintext password are not passed through SQL functions.
This avoids placing either value in SQL text, query statistics, or database
logs. The same frozen envelope protects an explicitly configured SMTP password.

## Hosted secret separation

Hosted SupaMail uses separate secrets for separate data classes:

| Secret class | Purpose | Storage |
| --- | --- | --- |
| Mailbox credential key (`IMAP_ENCRYPTION_KEY`) | Encrypt IMAP and SMTP passwords | Vercel and Fly runtime secrets |
| General Cloud envelope key (`SUPAMAIL_SECRET_ENCRYPTION_KEY`) | Encrypt persisted OAuth refresh tokens, BYO database credentials, Storage credentials, and webhook secrets | Vercel and Fly runtime secrets |
| Body-encryption root (`SUPAMAIL_BODY_ENCRYPTION_KEY`) | Encrypt complete body objects | A dedicated Vercel Sensitive variable and Fly secret |
| SupaMail-owned Supabase server keys and runtime database URLs | Server-side database and Storage access | Required server runtime only |
| Hosted search key (`TURBOPUFFER_API_KEY`) | Hosted search operations | Fly runtime only |
| Stripe and transactional-email keys | Billing and service email | Required Vercel runtime only |

The body-encryption root must not equal the general Cloud envelope key. Both
hosted readers fail closed if the two values match. A leak in one key class
therefore does not automatically expose every encrypted data class.

Provider keys are never browser variables. In particular, a secret must never
use a `NEXT_PUBLIC_` prefix. Public configuration can be visible in the browser;
server keys cannot.

## Hosted body-object encryption

Hosted SupaMail Cloud compresses the canonical body object and then encrypts it
before upload.

```text
root key
  |
  +-- HKDF-SHA-256(
        salt = lowercase Tenant UUID,
        context = "supamail-body-object-v2"
      )
        |
        +-- per-Tenant AES-256-GCM key

SMB2 || random IV (12 bytes) || GCM tag (16 bytes) || ciphertext
```

The authenticated associated data is:

```text
supamail-body-object-v2
<lowercase Tenant UUID>
<lowercase message UUID>
<plaintext SHA-256>
```

This binding means that copied ciphertext fails authentication if it is used
for a different Tenant, message, or body checksum. Authentication happens
before decompression and JSON parsing. Size limits apply before and after
decompression.

The root is a randomly generated 32-byte value represented as 64 lowercase
hexadecimal characters. The same root is available only to the required Vercel
and Fly server readers. The root value is not stored in Postgres, Supabase
Storage, logs, tests, pull requests, or this repository.

### Public compatibility vector

This test-only vector lets another implementation verify the envelope. None of
these values is a production secret.

| Input | Value |
| --- | --- |
| Root key | `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef` |
| Tenant UUID | `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` |
| Message UUID | `bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb` |
| Plaintext SHA-256 | `5e782bd6624d3e15dec50ea4313cc7c6d9afd90324b6050813b45b2332b81127` |
| IV | twelve bytes, each `0x07` |
| Compressed input, Base64 | `H4sIAAAAAAAAE6tWKkstKs7Mz1OyMtRRyk0tLk5MT/VMUbJSSoICXSwEDCjpKCXlp1SGpFaUKFkpFZfkF6WmKIBEoBIBOYmZeUpWeaU5OTpKxak5qcklqSkg1QGJRSUQ8VoAGxdpLIIAAAA=` |
| Encrypted envelope, Base64 | `U01CMgcHBwcHBwcHBwcHB3yD5aaxDmkVtizEmk0eAGIV8UnKvV5NmVoghA2mmDuyqBMw6hMiSSrOpB/8lCIx218jibfauxOy+DrHnVY01M7u7HUUDfU0WvD5dkkRLUiMLPgp/RZk8Ms5gw3MH+y9HuhNXEWJFg3FeDecVM50AgbpOfYs2TppZL1ouA==` |

The Fly runtime and Vercel reader must produce or accept this exact envelope.
Changing the Tenant, message, checksum, root key, IV, authentication tag, or
ciphertext must make authentication fail.

### Rollout safety

Body encryption uses a reader-first rollout:

1. Add retry state and bounded due-row indexes.
2. Deploy compatible readers with encrypted writes disabled.
3. Verify the readers.
4. Enable encrypted writes.
5. Upgrade legacy body objects in bounded batches.
6. Verify that no legacy pointers or unreferenced legacy objects remain.

An upgrader overwrites a body object, verifies that the encrypted result is
readable, and only then advances its database pointer. Failures leave the
legacy pointer visible and retry with bounded backoff. A failed object cannot
silently count as complete.

## Why search still works

Hosted search needs readable text. The runtime receives plaintext from IMAP,
creates a bounded search representation, and sends that representation to the
hosted search provider. The complete body object is encrypted separately before
Storage upload.

This keeps search, MCP reads, REST reads, and reply preparation functional. It
also means the runtime and search provider remain inside the trusted hosted
processing boundary. Client-held keys and zero-knowledge search are not current
product claims.

The public body-store seam is documented in
[ADR 0028](architecture/decisions/0028-content-extract-body-store-seam.md).
It commits bounded search and threading evidence before the full payload enters
the selected body store.

## Known limits

- Headers and mailbox metadata are not application-layer encrypted.
- Hosted search representations are readable to the hosted search system.
- A privileged production operator can access plaintext or keys.
- The body-encryption root is a high-value secret shared by the two required
  hosted server readers.
- Body-key rotation requires a versioned re-encryption procedure. Rotating or
  losing the root before that procedure would make stored bodies unreadable.
- Application-layer encryption does not replace least privilege, audit logs,
  row-level security, private buckets, TLS, provider access controls, backups,
  or incident response.

## What this repository proves

The public repository lets a reviewer inspect:

- the credential encryption implementation and tests;
- the public database schema and row-level security;
- the evidence-first body-store interface;
- the local API, CLI, and read-only MCP boundaries;
- the public contracts required of the hosted product;
- this hosted cryptographic format and its explicit non-goals.

The hosted multi-Tenant implementation and production deployment repository are
private. This repository therefore does not prove the current contents of a
provider secret manager or every production access-control setting. The public
model is intended to make the design reviewable without pretending that private
deployment evidence is public.

Report suspected vulnerabilities through the private process in
[`SECURITY.md`](../SECURITY.md). Never include real credentials, tokens, email
content, or customer data in a report.
