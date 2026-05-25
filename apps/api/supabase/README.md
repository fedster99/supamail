# Supabase Setup

Run the public mirror migrations in `migrations/public/` against the Supabase Postgres database used by the worker. `manifest.json` records the ordered public migration list and required public schema version.

For hosted Supabase, use the direct connection string for the worker. Advisory locks require session affinity, so do not use a transaction-pooler URL for `DATABASE_URL`.

Required extensions:

- `pgcrypto`
