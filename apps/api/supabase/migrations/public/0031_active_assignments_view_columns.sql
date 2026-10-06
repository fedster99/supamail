-- 0031_active_assignments_view_columns.sql
--
-- imap_thread_active_assignments selects assignment.*, and Postgres fixes that
-- column list when the view is created. 0020 and 0023 later added columns to
-- imap_thread_assignments, so a database that applied 0014 once had a narrower
-- view than one that re-applied it. Re-applying every migration on each migrate
-- hid the difference until migrations began to run once (ADR 0040). Recreate the
-- view so it has the same shape on every host, without the security barrier that
-- 0029 removed. A schema test keeps its columns equal to the table's.
CREATE OR REPLACE VIEW public.imap_thread_active_assignments
WITH (security_invoker = true)
AS
SELECT assignment.*
FROM public.imap_thread_state state
JOIN public.imap_thread_runs run
  ON run.id = state.active_run_id
 AND run.account_id = state.account_id
 AND run.status = 'active'
JOIN public.imap_thread_assignments assignment
  ON assignment.run_id = run.id
 AND assignment.account_id = state.account_id;
