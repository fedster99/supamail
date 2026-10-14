-- 0034_folder_unreadable_messages.sql
--
-- Per folder generation, the messages whose metadata could not be read, keyed
-- by UID: a fixed error code, the attempt count, and the last failure time. No
-- message content. A message that fails three times is skipped, so one bad
-- message cannot stop its folder, and get_sync_status counts it. A UIDVALIDITY
-- reset clears the record with the rest of the folder's cursors.

ALTER TABLE public.imap_folders
  ADD COLUMN IF NOT EXISTS unreadable_messages jsonb;
