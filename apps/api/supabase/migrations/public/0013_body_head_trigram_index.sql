-- 0013_body_head_trigram_index.sql
--
-- Body FTS in 0008 covers natural-language lexical search. Exact substring
-- consumers still need pg_trgm for identifiers, amounts, URLs, and sparse
-- literal queries. Index only the same 128 KiB body head used by body_fts so
-- pathological MIME/text bodies cannot make exact search unbounded.
--
-- The expression is intentionally stable and public: downstream read adapters
-- must use it verbatim for PostgreSQL to select this expression index.
--
-- Public migrations execute as one implicit transaction, so this follows the
-- established additive/idempotent convention and does not use CONCURRENTLY.

CREATE INDEX IF NOT EXISTS imap_message_bodies_body_head_trgm_idx
  ON public.imap_message_bodies
  USING gin (
    (left(coalesce(body_text, body_plain, selected_text_part, ''), 131072))
    extensions.gin_trgm_ops
  );
