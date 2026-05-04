CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.imap_mirror_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.imap_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_address extensions.citext NOT NULL UNIQUE,
  provider_profile text NOT NULL DEFAULT 'generic-imap',
  host text NOT NULL,
  port integer NOT NULL,
  secure boolean NOT NULL DEFAULT true,
  username text NOT NULL,
  encrypted_password bytea NOT NULL,
  body_fetch_policy text NOT NULL DEFAULT 'priority_then_backfill'
    CHECK (body_fetch_policy IN ('immediate', 'lazy', 'priority_then_backfill')),
  sync_state text NOT NULL DEFAULT 'INITIAL_SYNC'
    CHECK (sync_state IN ('INITIAL_SYNC', 'HEALTHY', 'DEGRADED', 'BROKEN', 'PAUSED')),
  sync_state_reason text,
  last_sync_started_at timestamptz,
  last_sync_finished_at timestamptz,
  priority_sync_lag_seconds integer,
  overall_sync_lag_seconds integer,
  consecutive_failures integer NOT NULL DEFAULT 0,
  consecutive_successes integer NOT NULL DEFAULT 0,
  currently_syncing boolean NOT NULL DEFAULT false,
  sync_started_by text,
  current_backoff_ms integer NOT NULL DEFAULT 0,
  backoff_until timestamptz,
  lock_id bigserial NOT NULL UNIQUE,
  folder_rr_cursor integer NOT NULL DEFAULT 0,
  last_folder_discovery_at timestamptz,
  next_folder_discovery_at timestamptz,
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS imap_accounts_set_updated_at ON public.imap_accounts;
CREATE TRIGGER imap_accounts_set_updated_at
  BEFORE UPDATE ON public.imap_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.imap_mirror_set_updated_at();

CREATE TABLE IF NOT EXISTS public.imap_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
  path text NOT NULL,
  delimiter text,
  special_use text,
  last_seen_in_provider_at timestamptz,
  missing_since timestamptz,
  tracked boolean NOT NULL DEFAULT true,
  excluded_reason text,
  sync_priority integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'SYNCING', 'ACTIVE', 'NEEDS_FULL_RESYNC', 'MISSING')),
  uidvalidity bigint,
  uid_next bigint,
  highest_modseq numeric,
  last_uid bigint,
  last_synced_at timestamptz,
  initial_sync_complete boolean NOT NULL DEFAULT false,
  initial_sync_target_max_uid bigint,
  initial_sync_oldest_uid_synced bigint,
  last_progress_at timestamptz,
  last_progress_uid bigint,
  last_progress_note text,
  next_sync_due_at timestamptz,
  next_flag_scan_at timestamptz,
  next_reconcile_at timestamptz,
  last_full_reconcile_at timestamptz,
  last_reconcile_clean boolean,
  uidvalidity_reset_count integer NOT NULL DEFAULT 0,
  last_uidvalidity_reset_at timestamptz,
  backfill_in_progress boolean NOT NULL DEFAULT false,
  backfill_target_max_uid bigint,
  backfill_oldest_uid_synced bigint,
  backfill_since_date timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, path)
);

CREATE INDEX IF NOT EXISTS imap_folders_due_idx
  ON public.imap_folders (account_id, tracked, status, sync_priority, next_sync_due_at);

DROP TRIGGER IF EXISTS imap_folders_set_updated_at ON public.imap_folders;
CREATE TRIGGER imap_folders_set_updated_at
  BEFORE UPDATE ON public.imap_folders
  FOR EACH ROW
  EXECUTE FUNCTION public.imap_mirror_set_updated_at();

CREATE TABLE IF NOT EXISTS public.imap_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES public.imap_folders(id) ON DELETE SET NULL,
  folder_path text NOT NULL,
  uidvalidity bigint NOT NULL,
  uid bigint NOT NULL,
  rfc_message_id text,
  message_id_normalized text,
  provider_thread_id text,
  in_reply_to text,
  references_header text,
  internal_date timestamptz NOT NULL,
  size_bytes integer,
  subject text,
  from_email text,
  from_name text,
  to_emails text[],
  to_names text[],
  cc_emails text[],
  cc_names text[],
  bcc_emails text[],
  flags text[],
  headers_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  mime_structure jsonb,
  body_fetched_at timestamptz,
  deleted_in_provider boolean NOT NULL DEFAULT false,
  provider_deleted_at timestamptz,
  deleted_reason text CHECK (
    deleted_reason IS NULL OR deleted_reason IN (
      'PROVIDER_DELETED',
      'MOVED_OUT',
      'FOLDER_MISSING',
      'UIDVALIDITY_RESET',
      'RECONCILE_MISSING'
    )
  ),
  window_status text NOT NULL DEFAULT 'IN_WINDOW'
    CHECK (window_status IN ('IN_WINDOW', 'EXPIRED', 'HISTORICAL')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, folder_path, uidvalidity, uid)
);

CREATE INDEX IF NOT EXISTS imap_messages_account_date_idx
  ON public.imap_messages (account_id, internal_date DESC, id DESC)
  WHERE deleted_in_provider = false;

CREATE INDEX IF NOT EXISTS imap_messages_folder_uid_idx
  ON public.imap_messages (account_id, folder_path, uidvalidity, uid)
  WHERE deleted_in_provider = false;

CREATE INDEX IF NOT EXISTS imap_messages_body_backlog_idx
  ON public.imap_messages (account_id, folder_path, uid DESC)
  WHERE deleted_in_provider = false
    AND window_status = 'IN_WINDOW'
    AND body_fetched_at IS NULL;

DROP TRIGGER IF EXISTS imap_messages_set_updated_at ON public.imap_messages;
CREATE TRIGGER imap_messages_set_updated_at
  BEFORE UPDATE ON public.imap_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.imap_mirror_set_updated_at();

CREATE TABLE IF NOT EXISTS public.imap_message_bodies (
  message_id uuid PRIMARY KEY REFERENCES public.imap_messages(id) ON DELETE CASCADE,
  raw_mime bytea NOT NULL,
  raw_bytes integer NOT NULL,
  raw_truncated boolean NOT NULL DEFAULT false,
  body_text text,
  body_html text,
  body_plain text,
  selected_text_part text,
  selected_text_format text CHECK (
    selected_text_format IS NULL OR selected_text_format IN ('plain', 'html')
  ),
  headers_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  mime_structure jsonb,
  parser_warnings text[],
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS imap_message_bodies_fetched_at_idx
  ON public.imap_message_bodies (fetched_at DESC);

DROP TRIGGER IF EXISTS imap_message_bodies_set_updated_at ON public.imap_message_bodies;
CREATE TRIGGER imap_message_bodies_set_updated_at
  BEFORE UPDATE ON public.imap_message_bodies
  FOR EACH ROW
  EXECUTE FUNCTION public.imap_mirror_set_updated_at();

CREATE TABLE IF NOT EXISTS public.imap_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.imap_messages(id) ON DELETE CASCADE,
  filename text,
  mime_type text,
  size_bytes integer,
  part_number text,
  content_id text,
  disposition text CHECK (disposition IS NULL OR disposition IN ('attachment', 'inline')),
  storage_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, part_number, content_id, filename)
);

CREATE INDEX IF NOT EXISTS imap_attachments_message_id_idx
  ON public.imap_attachments (message_id);

CREATE TABLE IF NOT EXISTS public.imap_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
  trigger_type text NOT NULL DEFAULT 'scheduled'
    CHECK (trigger_type IN ('scheduled', 'manual', 'api', 'backfill')),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'partial_success', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  folders_processed integer NOT NULL DEFAULT 0,
  messages_upserted integer NOT NULL DEFAULT 0,
  bodies_fetched integer NOT NULL DEFAULT 0,
  flags_updated integer NOT NULL DEFAULT 0,
  reconcile_gaps_found integer NOT NULL DEFAULT 0,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS imap_sync_runs_account_started_idx
  ON public.imap_sync_runs (account_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.imap_sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.imap_accounts(id) ON DELETE CASCADE,
  sync_run_id uuid REFERENCES public.imap_sync_runs(id) ON DELETE SET NULL,
  message_id uuid REFERENCES public.imap_messages(id) ON DELETE SET NULL,
  folder_path text,
  provider_uid bigint,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS imap_sync_events_account_type_idx
  ON public.imap_sync_events (account_id, event_type, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.imap_encrypt_password(plaintext text, encryption_key text)
RETURNS bytea
LANGUAGE sql
SET search_path = ''
AS $$
  SELECT extensions.pgp_sym_encrypt(plaintext, encryption_key)::bytea;
$$;

CREATE OR REPLACE FUNCTION public.imap_decrypt_password(encrypted bytea, encryption_key text)
RETURNS text
LANGUAGE sql
SET search_path = ''
AS $$
  SELECT extensions.pgp_sym_decrypt(encrypted, encryption_key);
$$;
