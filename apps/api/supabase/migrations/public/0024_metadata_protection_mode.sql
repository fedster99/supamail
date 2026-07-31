-- 0024_metadata_protection_mode.sql
--
-- Record the adapter mode once per Mailbox Account. Runtime compatibility
-- checks use this small indexed marker instead of scanning mirror relations.

ALTER TABLE public.imap_accounts
  ADD COLUMN IF NOT EXISTS metadata_protection_mode text NOT NULL DEFAULT 'plaintext';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.imap_accounts'::regclass
      AND conname = 'imap_accounts_metadata_protection_mode_check'
  ) THEN
    ALTER TABLE public.imap_accounts
      ADD CONSTRAINT imap_accounts_metadata_protection_mode_check
      CHECK (metadata_protection_mode IN ('plaintext', 'protected')) NOT VALID;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS imap_accounts_metadata_protection_mode_idx
  ON public.imap_accounts (metadata_protection_mode, id);

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
    constraint_name := relation_name || '_tokens_need_envelope_check';
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = format('public.%I', relation_name)::regclass
        AND conname = constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (
          protected_metadata IS NOT NULL
          OR protected_metadata_tokens IS NULL
        ) NOT VALID',
        relation_name,
        constraint_name
      );
    END IF;
  END LOOP;
END
$$;
