# SupaMail Context

## Glossary

### User

The human identity that signs in to the hosted product.

### Customer

The billing identity responsible for paying for hosted product access.

### Tenant

The product container owned by a user or customer. A tenant groups hosted product access, entitlement, and connected resources.

For v1, a tenant has one active mirror target.

Tenant entitlement is separate from mirror target readiness. A tenant can retain hosted product access while its mirror target is paused or needs attention.

### Mirror Target

A Postgres or Supabase database that receives mailbox mirror data.

For Hosted BYO Supabase, the customer brings the mirror target and SupaMail Cloud runs synchronization into it.

SupaMail Cloud may store an encrypted connection secret for a mirror target so it can operate that target.

A mirror target must be migrated to the required public schema version before SupaMail Cloud runs sync, API, or MCP work against it.

### Public Core

The reusable SupaMail sync engine and mirror schema published from the OSS repository.

### Cloud Runtime

The private hosted process that operates tenants and mirror targets using the public core.

### IMAP Account

A mailbox configured for synchronization.

For Hosted BYO Supabase, the IMAP account credentials persist in the customer's mirror target, encrypted by the public core.

### Mailbox Account

Synonym for IMAP Account. Use this when "IMAP Account" would be too protocol-specific in product copy.

### Account

Avoid this term by itself. Use User, Customer, Tenant, Mirror Target, IMAP Account, or Mailbox Account instead.
