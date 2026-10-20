-- Memory hardening, CONTRACT step (decision 0009, docs/DEPLOYMENT.md).
--
-- Step 3 of 3. Apply this only after:
-- 1. the expand migration 20261021000000_memory_hardening.sql (PR #18) is
--    applied, and
-- 2. the code of PR #13, which calls public.decide_action_proposal and no
--    longer writes the action log, serves all traffic, no Preview of an
--    older branch is in use, and older requests have ended.
-- Older code uses the grants removed here. After this step, roll the Worker
-- back only to the PR #13 version or a later one.
--
-- After this migration:
-- - only the trigger functions write the action log;
-- - only public.decide_action_proposal changes an action proposal.
-- An outcome that a caller wrote before this step keeps
-- decided_by_function = false, so it never reads as verified. An older
-- request that claimed a proposal and has not stored its result gets 42501
-- on that write: the proposal stays 'approved' and not verified, and
-- decide_action_proposal will not run it again. Older rows are handled by
-- the procedure for older rows in decision 0009.

drop policy if exists action_log_insert_own on public.action_log;
revoke insert on public.action_log from authenticated;

drop policy if exists action_proposals_update_own on public.action_proposals;
revoke update (status, result, decided_at) on public.action_proposals from authenticated;
revoke update on public.action_proposals from authenticated;
