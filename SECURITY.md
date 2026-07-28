# Security

## Security model

Read the public [Security and Privacy Model](docs/security-model.md) for:

- the self-hosted and hosted data boundaries;
- credential, token, API-key, and body-object protection;
- the hosted AES-256-GCM body envelope and per-Tenant key derivation;
- the threat model and known plaintext boundaries;
- the explicit reason SupaMail Cloud is not zero knowledge.

The model separates claims that this public repository proves from controls
that depend on the private hosted deployment.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub's **Security → Report a vulnerability** flow so the report and any
follow-up remain private until a fix is available. Include the affected
component, reproduction steps, impact, and any suggested mitigation.

SupaMail handles mailbox credentials and message data. Do not include real
credentials, tokens, private email content, or customer data in a report.

## Supported versions

SupaMail is pre-1.0. Security fixes are applied to the latest commit on `main`;
older commits and container images are not maintained as separate release
lines.
