-- 0010_search_recipient_indexes.sql
--
-- Serving trigram indexes for the per-recipient-lane search filters added by
-- email-005 (ADR 0015): to:/cc:/bcc:/anyEmail:. Migration 0008 indexed only the
-- combined to||cc "recipient" lane (imap_messages_recipients_trgm), so a
-- filter-only `bcc:x`, `to:x`, `cc:x`, or `anyemail:x` query in the no-free-text
-- path had NO serving trigram index and degraded to a full account scan, bounded
-- only by the 15s statement_timeout → slow/500 on a large mailbox.
--
-- Each index's expression matches the EXACT predicate emitted by search/compile.ts
-- (filterPredicate, lanes `to`/`cc`/`bcc`/`anyEmail`) so the planner can probe the
-- gin_trgm_ops index for the `lower(...) LIKE '%term%'` leading-wildcard match.
-- coalesce each array to '{}' so a NULL side does not drop the row, identical to
-- the 0008 recipients index. Partial `WHERE deleted_in_provider = false` mirrors
-- the candidate scope the search applies in every non-includeDeleted query.
--
-- DESIGN CONTRACT (see 0008_search_layer.sql header): additive + idempotent
-- (CREATE INDEX IF NOT EXISTS), runs inside the single implicit transaction of
-- applyPublicMigrations(), so NO CREATE INDEX CONCURRENTLY here.

-- to: lane — lower(f_array_to_text(coalesce(to_emails,'{}')))
CREATE INDEX IF NOT EXISTS imap_messages_to_emails_trgm
  ON public.imap_messages
  USING gin (
    lower(public.f_array_to_text(coalesce(to_emails, '{}'::text[]))) extensions.gin_trgm_ops
  )
  WHERE deleted_in_provider = false;

-- cc: lane — lower(f_array_to_text(coalesce(cc_emails,'{}')))
CREATE INDEX IF NOT EXISTS imap_messages_cc_emails_trgm
  ON public.imap_messages
  USING gin (
    lower(public.f_array_to_text(coalesce(cc_emails, '{}'::text[]))) extensions.gin_trgm_ops
  )
  WHERE deleted_in_provider = false;

-- bcc: lane — lower(f_array_to_text(coalesce(bcc_emails,'{}')))
CREATE INDEX IF NOT EXISTS imap_messages_bcc_emails_trgm
  ON public.imap_messages
  USING gin (
    lower(public.f_array_to_text(coalesce(bcc_emails, '{}'::text[]))) extensions.gin_trgm_ops
  )
  WHERE deleted_in_provider = false;

-- anyEmail: lane (Nylas any_email) — from_email + to + cc + bcc flattened to one
-- lowercased blob. The expression MUST match filterPredicate's `anyEmail` exactly.
CREATE INDEX IF NOT EXISTS imap_messages_any_email_trgm
  ON public.imap_messages
  USING gin (
    lower(
      coalesce(from_email, '') || ' ' || public.f_array_to_text(
        coalesce(to_emails, '{}'::text[])
          || coalesce(cc_emails, '{}'::text[])
          || coalesce(bcc_emails, '{}'::text[])
      )
    ) extensions.gin_trgm_ops
  )
  WHERE deleted_in_provider = false;
