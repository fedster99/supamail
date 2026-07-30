-- 0023_metadata_protection_seam.sql
--
-- Add neutral storage columns for an application-layer metadata adapter.
-- Public core does not encrypt, decrypt, derive keys, or interpret exact-match
-- tokens. The readable identity adapter leaves every new column NULL.

ALTER TABLE public.imap_accounts
  ADD COLUMN IF NOT EXISTS protected_metadata bytea,
  ADD COLUMN IF NOT EXISTS protected_metadata_version smallint,
  ADD COLUMN IF NOT EXISTS protected_metadata_key_version integer,
  ADD COLUMN IF NOT EXISTS protected_metadata_tokens jsonb;

ALTER TABLE public.imap_messages
  ADD COLUMN IF NOT EXISTS protected_metadata bytea,
  ADD COLUMN IF NOT EXISTS protected_metadata_version smallint,
  ADD COLUMN IF NOT EXISTS protected_metadata_key_version integer,
  ADD COLUMN IF NOT EXISTS protected_metadata_tokens jsonb;

ALTER TABLE public.imap_message_bodies
  ADD COLUMN IF NOT EXISTS protected_metadata bytea,
  ADD COLUMN IF NOT EXISTS protected_metadata_version smallint,
  ADD COLUMN IF NOT EXISTS protected_metadata_key_version integer,
  ADD COLUMN IF NOT EXISTS protected_metadata_tokens jsonb;

ALTER TABLE public.imap_attachments
  ADD COLUMN IF NOT EXISTS protected_metadata bytea,
  ADD COLUMN IF NOT EXISTS protected_metadata_version smallint,
  ADD COLUMN IF NOT EXISTS protected_metadata_key_version integer,
  ADD COLUMN IF NOT EXISTS protected_metadata_tokens jsonb;

ALTER TABLE public.imap_message_evidence
  ADD COLUMN IF NOT EXISTS protected_metadata bytea,
  ADD COLUMN IF NOT EXISTS protected_metadata_version smallint,
  ADD COLUMN IF NOT EXISTS protected_metadata_key_version integer,
  ADD COLUMN IF NOT EXISTS protected_metadata_tokens jsonb;

ALTER TABLE public.imap_thread_assignments
  ADD COLUMN IF NOT EXISTS protected_metadata bytea,
  ADD COLUMN IF NOT EXISTS protected_metadata_version smallint,
  ADD COLUMN IF NOT EXISTS protected_metadata_key_version integer,
  ADD COLUMN IF NOT EXISTS protected_metadata_tokens jsonb;

ALTER TABLE public.imap_thread_assignment_history
  ADD COLUMN IF NOT EXISTS protected_metadata bytea,
  ADD COLUMN IF NOT EXISTS protected_metadata_version smallint,
  ADD COLUMN IF NOT EXISTS protected_metadata_key_version integer,
  ADD COLUMN IF NOT EXISTS protected_metadata_tokens jsonb;

DO $$
DECLARE
  relation_name text;
  constraint_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'imap_accounts',
    'imap_messages',
    'imap_message_bodies',
    'imap_attachments',
    'imap_message_evidence',
    'imap_thread_assignments',
    'imap_thread_assignment_history'
  ]
  LOOP
    constraint_name := relation_name || '_protected_metadata_check';
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = format('public.%I', relation_name)::regclass
        AND conname = constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (
          (
            protected_metadata IS NULL
            AND protected_metadata_version IS NULL
            AND protected_metadata_key_version IS NULL
          )
          OR (
            protected_metadata IS NOT NULL
            AND protected_metadata_version > 0
            AND protected_metadata_key_version > 0
          )
        ) NOT VALID',
        relation_name,
        constraint_name
      );
    END IF;

    constraint_name := relation_name || '_protected_metadata_tokens_check';
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = format('public.%I', relation_name)::regclass
        AND conname = constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (
          protected_metadata_tokens IS NULL
          OR jsonb_typeof(protected_metadata_tokens) = ''object''
        ) NOT VALID',
        relation_name,
        constraint_name
      );
    END IF;
  END LOOP;
END
$$;
