-- SMTP send coordinates for the single-account send/reply primitive (email-001).
-- Columns live on the 1:1 imap_accounts row, not a side table. All nullable:
-- a NULL smtp_username/encrypted_smtp_password means "reuse the IMAP username /
-- encrypted_password", covering the common "same creds, SMTP on 465/587" case
-- with zero extra onboarding input. encrypted_smtp_password uses the SAME frozen
-- AES-256-GCM envelope as encrypted_password (the engine decrypts it).
ALTER TABLE public.imap_accounts
  ADD COLUMN IF NOT EXISTS smtp_host text,
  ADD COLUMN IF NOT EXISTS smtp_port integer,
  ADD COLUMN IF NOT EXISTS smtp_secure boolean,            -- true = implicit TLS (465); false = STARTTLS (587)
  ADD COLUMN IF NOT EXISTS smtp_username text,             -- NULL => reuse username
  ADD COLUMN IF NOT EXISTS encrypted_smtp_password bytea;  -- NULL => reuse encrypted_password
