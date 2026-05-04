# Supabase Setup

Run the migration in `migrations/0001_imap_mirror.sql` against the Supabase Postgres database used by the worker.

For hosted Supabase, use the direct connection string for the worker. Advisory locks require session affinity, so do not use a transaction-pooler URL for `DATABASE_URL`.

Required extensions:

- `pgcrypto`
- `citext`
