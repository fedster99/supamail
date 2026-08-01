-- 0007_search_layer.sql
--
-- Adds the SupaMail search layer: deterministic, pure-Postgres full-text +
-- trigram + structured-predicate retrieval over the mirror.
--
-- DESIGN CONTRACT (see docs/architecture/decisions/0015-search-layer.md):
--   * PUBLIC CORE, per-account Supabase/Postgres. The SAME file runs on every
--     self-hoster and customer database. Fully additive and idempotent
--     (CREATE ... IF NOT EXISTS / guarded DO blocks). It is safe to run
--     repeatedly and never breaks existing reliability migrations.
--   * The whole public migration set is concatenated and executed in ONE
--     implicit transaction by applyPublicMigrations() (db.ts: single
--     client.query(sql)). Therefore NOTHING here may use CREATE INDEX
--     CONCURRENTLY or any other statement illegal inside a transaction block.
--   * Tier 0/1 (this file, MANDATORY): 100% pure Postgres. Weighted tsvector
--     FTS, pg_trgm fuzzy/identifier matching, btree_gin account-scoped GIN, and
--     structured b-tree predicates. Zero external services. Deterministic.
--   * Tier 2 (this file, OPT-IN, self-gated): an optional pgvector embeddings
--     table + HNSW index, created ONLY if the `vector` extension is already
--     installed. It NO-OPS cleanly when pgvector is absent, so the pure core
--     never requires an embedding model. Embeddings are populated out-of-core.
--   * Access boundary: search runs as a trusted server-side connection (RLS
--     bypassed), so account_id is the ONLY account boundary and is baked into
--     every search index. The RLS / anon / authenticated posture is inherited
--     unchanged from 0001 for existing tables; the one new (opt-in) table sets
--     its own posture below.
--
-- LARGE EXISTING MIRRORS: the two ADD COLUMN ... GENERATED STORED rewrite the
-- tables and the GIN builds take table-level locks while this transaction holds
-- the public-migration advisory lock. On a fresh/empty database this is
-- instant. On a populated mirror, pre-build the columns + indexes out of band
-- BEFORE flipping the schema version so every object here already exists and
-- IF NOT EXISTS no-ops.
--
-- WRITE-PATH SAFETY:
--   * header_fts is a STORED generated column on imap_messages, computed once per
--     upsertMessages INSERT and recomputed only when a weighted source column
--     actually changes. The hot flag-rescan UPDATE (flags / headers_json /
--     mime_structure / deleted_in_provider) touches no header_fts source column,
--     so Postgres does NOT recompute the tsvector on a flag rescan.
--   * body_fts is a STORED generated column on imap_message_bodies, computed
--     exactly when storeBody writes the row. No trigger, no cross-table write,
--     no late-arrival staleness.
--   * No trigger is added to either hot table. The body index is driven from
--     imap_messages (the authoritative, account- and soft-delete-scoped side)
--     via JOIN, so account_id / deleted_in_provider are never denormalized onto
--     imap_message_bodies and search can never leak a soft-deleted body.

-- ---------------------------------------------------------------------------
-- 0. Extensions. Installed into the `extensions` schema to match the 0001
--    convention (pgcrypto WITH SCHEMA extensions). All idempotent.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent  WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm   WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- 1. IMMUTABLE helpers. unaccent() and array_to_string() are STABLE, not
--    IMMUTABLE, so neither can appear directly in a GENERATED ALWAYS expression
--    or an expression index. Pin the dictionary / coalesce and re-mark each
--    wrapper IMMUTABLE. search_path is locked to '' so the bodies are
--    schema-qualified and cannot be hijacked.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.f_unaccent(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = ''
AS $$
  SELECT extensions.unaccent('extensions.unaccent', $1)
$$;

-- NULL-safe text[] -> text join. A NULL array (or a NULL produced by `a || b`
-- when one side is NULL) collapses to '' so the generated column / index
-- expression is always non-NULL and stable.
CREATE OR REPLACE FUNCTION public.f_array_to_text(text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT coalesce(array_to_string($1, ' '), '')
$$;

-- ---------------------------------------------------------------------------
-- 2. Weighted FTS documents as STORED generated columns. Two columns, not one,
--    because a generated column may only reference columns of its own row:
--    imap_messages cannot read the sibling imap_message_bodies row, so the body
--    document lives on the body table. Search combines them at query time via
--    JOIN + OR of the two GIN indexes.
--
--    Config 'english': stems prose, drops stopwords (good recall on
--    subjects/bodies). Exact identifier matching (emails, message-ids) is the
--    pg_trgm path in section 4, NOT stemmed FTS. The query layer parses input
--    with the SAME websearch_to_tsquery('english', ...).
-- ---------------------------------------------------------------------------

-- 2a. Header document on imap_messages (always present; same-row inputs only).
--     A = subject, B = sender (name+email), C = recipients (to/cc). left() caps
--     a pathological subject before it reaches the parser.
ALTER TABLE public.imap_messages
  ADD COLUMN IF NOT EXISTS header_fts tsvector
  GENERATED ALWAYS AS (
      setweight(to_tsvector('english', public.f_unaccent(left(coalesce(subject, ''), 32768))), 'A')
   || setweight(to_tsvector('english', public.f_unaccent(
        coalesce(from_name, '') || ' ' || coalesce(from_email, ''))), 'B')
   || setweight(to_tsvector('english', public.f_unaccent(
        public.f_array_to_text(to_names)  || ' ' ||
        public.f_array_to_text(to_emails) || ' ' ||
        public.f_array_to_text(cc_names)  || ' ' ||
        public.f_array_to_text(cc_emails))), 'C')
  ) STORED;

-- 2b. Body document on imap_message_bodies (weight D; arrives late, recomputes
--     automatically on body INSERT/UPDATE). body_text is the HTML-stripped plain
--     text (bodyPlain ?? htmlToText(bodyHtml)), so it never indexes tag soup.
--     CAP = 131072 chars (128KB): the ~1MB limit is on the OUTPUT tsvector and
--     real prose at 1M chars can overflow and ERROR the storeBody write.
ALTER TABLE public.imap_message_bodies
  ADD COLUMN IF NOT EXISTS body_fts tsvector
  GENERATED ALWAYS AS (
    setweight(
      to_tsvector('english', public.f_unaccent(
        left(coalesce(body_text, body_plain, selected_text_part, ''), 131072))),
      'D')
  ) STORED;

-- ---------------------------------------------------------------------------
-- 3. FTS GIN indexes.
--
--    btree_gin lets account_id ride in the SAME GIN index as the tsvector, so
--    "WHERE account_id = $1 AND header_fts @@ q" is satisfied in the index with
--    no cross-account posting scan. PARTIAL on deleted_in_provider = false
--    matches 0001 and keeps soft-deleted rows out. The partial predicate is a
--    LITERAL (= false), so the search layer MUST emit `deleted_in_provider =
--    false` as a constant for the planner to use these indexes.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS imap_messages_header_fts_gin
  ON public.imap_messages
  USING gin (account_id, header_fts)
  WHERE deleted_in_provider = false;

-- Body GIN. imap_message_bodies has NO account_id / deleted_in_provider column
-- and we intentionally do NOT denormalize them. Every search drives from
-- imap_messages (authoritative, account- and soft-delete-scoped) JOIN
-- imap_message_bodies, using body_fts only as a JOIN predicate. Partial on
-- `body_fts IS NOT NULL` keeps rows with no fetched body (late-body window) out.
CREATE INDEX IF NOT EXISTS imap_message_bodies_body_fts_gin
  ON public.imap_message_bodies
  USING gin (body_fts)
  WHERE body_fts IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Trigram (pg_trgm) indexes for typo/substring and identifier matching
--    (emails, filenames) that stemmed FTS cannot do. Indexes are on lower(...)
--    expressions so the app's lowercased query terms are index-usable.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS imap_messages_subject_trgm
  ON public.imap_messages
  USING gin (lower(subject) extensions.gin_trgm_ops)
  WHERE deleted_in_provider = false;

CREATE INDEX IF NOT EXISTS imap_messages_from_email_trgm
  ON public.imap_messages
  USING gin (lower(from_email) extensions.gin_trgm_ops)
  WHERE deleted_in_provider = false;

CREATE INDEX IF NOT EXISTS imap_messages_from_name_trgm
  ON public.imap_messages
  USING gin (lower(from_name) extensions.gin_trgm_ops)
  WHERE deleted_in_provider = false;

-- Fuzzy/substring recipient search across to+cc, flattened to lowercased text.
-- coalesce each side to '{}' so a NULL on one side does not drop the other.
CREATE INDEX IF NOT EXISTS imap_messages_recipients_trgm
  ON public.imap_messages
  USING gin (
    lower(public.f_array_to_text(
      coalesce(to_emails, '{}'::text[]) || coalesce(cc_emails, '{}'::text[])
    )) extensions.gin_trgm_ops
  )
  WHERE deleted_in_provider = false;

-- Attachment filename fuzzy/glob search (filename:*.pdf, "invoic", typos).
CREATE INDEX IF NOT EXISTS imap_attachments_filename_trgm
  ON public.imap_attachments
  USING gin (lower(filename) extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 5. Exact-membership array GIN -- FLAGS ONLY.
--    NO to_emails / cc_emails array GINs: emails are stored verbatim, so
--    `to_emails @> ARRAY[:addr]` silently misses mixed-case addresses. Exact
--    recipient search uses lower() + EXISTS(unnest ...) (see the read layer),
--    assisted by imap_messages_recipients_trgm above. Flag tokens are case-exact
--    so a flags GIN is correct.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS imap_messages_flags_gin
  ON public.imap_messages
  USING gin (flags)
  WHERE deleted_in_provider = false;

-- ---------------------------------------------------------------------------
-- 6. Structured-predicate b-tree indexes. date range + has:attachment already
--    use the 0001 indexes (imap_messages_account_date_idx,
--    imap_attachments_message_id_idx); we add only what is missing.
-- ---------------------------------------------------------------------------

-- size_bytes range (larger: / smaller: / size:a..b)
CREATE INDEX IF NOT EXISTS imap_messages_account_size_idx
  ON public.imap_messages (account_id, size_bytes)
  WHERE deleted_in_provider = false;

-- in:FOLDER + newest-first
CREATE INDEX IF NOT EXISTS imap_messages_account_folder_date_idx
  ON public.imap_messages (account_id, folder_path, internal_date DESC)
  WHERE deleted_in_provider = false;

-- from:PERSON exact-sender browse, newest-first (lower() for case-insensitive)
CREATE INDEX IF NOT EXISTS imap_messages_account_from_email_date_idx
  ON public.imap_messages (account_id, lower(from_email), internal_date DESC)
  WHERE deleted_in_provider = false;

-- from:@domain exact-domain filter
CREATE INDEX IF NOT EXISTS imap_messages_from_domain_idx
  ON public.imap_messages (account_id, lower(split_part(from_email, '@', 2)))
  WHERE deleted_in_provider = false;

-- is:unread is a NEGATION; bake it into a partial so "unread, newest first" is
-- a tiny ordered scan instead of a flags recheck over the whole account.
CREATE INDEX IF NOT EXISTS imap_messages_unread_date_idx
  ON public.imap_messages (account_id, internal_date DESC)
  WHERE deleted_in_provider = false
    AND NOT (flags @> ARRAY['\Seen']::text[]);

-- thread:ID grouping
CREATE INDEX IF NOT EXISTS imap_messages_thread_idx
  ON public.imap_messages (account_id, provider_thread_id)
  WHERE deleted_in_provider = false
    AND provider_thread_id IS NOT NULL;

-- attachment mime-class filter (filetype:pdf / attachment-type:image)
CREATE INDEX IF NOT EXISTS imap_attachments_mime_idx
  ON public.imap_attachments (message_id, mime_type);

-- ---------------------------------------------------------------------------
-- 7. TIER 2 (OPT-IN): semantic embeddings via pgvector.
--
--    This block NO-OPS unless the `vector` extension is ALREADY installed. The
--    pure core never requires pgvector. Self-hosters opt in by running
--    `CREATE EXTENSION vector WITH SCHEMA extensions;` BEFORE this migration (or
--    before a re-run; the block is idempotent). When pgvector is absent, search
--    is 100% deterministic FTS + trigram with no loss of correctness.
--
--    Embeddings live in a SEPARATE table, not columns on the hot imap_messages
--    row, so the metadata row stays narrow and the feature is cleanly
--    additive/removable. Populated out-of-core; NULL until then; the search SQL
--    null-guards so "no embeddings yet" === deterministic FTS-only ranking.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE $ddl$
      CREATE TABLE IF NOT EXISTS public.imap_message_embeddings (
        message_id   uuid PRIMARY KEY REFERENCES public.imap_messages(id) ON DELETE CASCADE,
        account_id   uuid NOT NULL REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
        model        text NOT NULL,
        dim          int  NOT NULL,
        content_hash text NOT NULL,
        embedding    extensions.vector(1536) NOT NULL,
        embedded_at  timestamptz NOT NULL DEFAULT now()
      )
    $ddl$;

    EXECUTE 'CREATE INDEX IF NOT EXISTS imap_message_embeddings_account_idx '
         || 'ON public.imap_message_embeddings (account_id)';

    EXECUTE 'CREATE INDEX IF NOT EXISTS imap_message_embeddings_hnsw '
         || 'ON public.imap_message_embeddings '
         || 'USING hnsw (embedding extensions.vector_cosine_ops) '
         || 'WITH (m = 16, ef_construction = 64)';

    EXECUTE 'ALTER TABLE public.imap_message_embeddings ENABLE ROW LEVEL SECURITY';

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON TABLE public.imap_message_embeddings FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON TABLE public.imap_message_embeddings FROM authenticated';
    END IF;
  END IF;
END $$;
