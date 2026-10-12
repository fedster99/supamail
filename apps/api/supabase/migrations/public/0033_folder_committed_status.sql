-- 0033_folder_committed_status.sql
--
-- Store the MESSAGES and UNSEEN values a pass proved, beside the UIDVALIDITY,
-- UIDNEXT, and HIGHESTMODSEQ cursors it already stores. A listener that starts
-- or reconnects compares the provider's folder status with these committed
-- values; a field with no committed value counts as different. A pass writes
-- MESSAGES after a complete reconcile or QRESYNC replay, or when it fetched
-- every new UID and MESSAGES equals the committed count plus them. A pass that
-- moves UIDNEXT without that proof clears it. UNSEEN is written after a
-- complete flag scan from the host's observation of the folder. A UIDVALIDITY
-- reset clears both.

ALTER TABLE public.imap_folders
  ADD COLUMN IF NOT EXISTS committed_messages bigint,
  ADD COLUMN IF NOT EXISTS committed_unseen bigint;
