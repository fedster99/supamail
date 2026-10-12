-- 0033_folder_committed_status.sql
--
-- Store the MESSAGES and UNSEEN values a pass proved, beside the UIDVALIDITY,
-- UIDNEXT, and HIGHESTMODSEQ cursors it already stores. A listener that starts
-- or reconnects compares the provider's folder status with these committed
-- values; a field with no committed value counts as different. A pass writes
-- MESSAGES when it checked deletions (a clean reconcile or a complete QRESYNC
-- replay) and fetched every new UID below the UIDNEXT it stores; a pass that
-- mirrors new UIDs without that proof clears it. UNSEEN is the host's
-- observation before flag work that covered the mirror's flag window. A
-- UIDVALIDITY reset clears both.

ALTER TABLE public.imap_folders
  ADD COLUMN IF NOT EXISTS committed_messages bigint,
  ADD COLUMN IF NOT EXISTS committed_unseen bigint;
