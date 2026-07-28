# Hosted Product Boundary

SupaMail OSS is the mailbox mirror. It syncs IMAP accounts into Postgres/Supabase and exposes worker, API, CLI, schema, Docker, and Fly deployment surfaces for self-hosted use.

The public repo intentionally does not include the hosted SaaS wrapper:

- public signup and login flows
- billing, prices, checkout, or Stripe webhooks
- transactional email provider setup
- hosted tenant provisioning
- user, organization, subscription, or entitlement tables
- multi-tenant onboarding or support operations

Those pieces belong in a separate private hosted-product repository. That private app can call the SupaMail API or run provisioning jobs against a SupaMail deployment, but it should not couple hosted billing and account lifecycle back into the sync core.

Self-hosting docs should stay focused on a user operating their own SupaMail worker and database. They should not become a turnkey guide for cloning the hosted product.

The public core may expose contracts that the hosted product consumes, such as public mirror migrations, Docker images, runtime entrypoints, and scheduler types. It must not store hosted control-plane migrations or secrets.

For Supabase OAuth integrations in the hosted product, refresh tokens must be encrypted before storage. The encryption key belongs in Fly/Vercel secrets only; plaintext refresh tokens must not appear in the control-plane database, public docs, logs, PRs, or example env files.

The hosted source remains private, but its security claims must be public and
specific. The [Security and Privacy Model](security-model.md) publishes the key
separation, body-object encryption format, threat model, non-goals, and limits
without publishing secret values or private multi-Tenant orchestration code.
