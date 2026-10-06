-- 0031_active_assignments_view_columns.sql
--
-- imap_thread_active_assignments selects assignment.*, and Postgres fixes that
-- column list when the view is created. 0023 later added the protected metadata
-- columns to imap_thread_assignments, so a database that applied 0014 once never
-- exposed them through the view. Re-applying every migration on each migrate hid
-- this until migrations began to run once (ADR 0040). Recreate the view so it
-- exposes every current assignment column, without the security barrier that
-- 0029 removed.
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
