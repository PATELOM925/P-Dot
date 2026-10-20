-- Memory hardening, CONTRACT step (decision 0009).
--
-- Apply this only after the code from the expand step is live: migration
-- 20261021000000_memory_hardening.sql and the code that calls
-- public.decide_action_proposal and no longer writes the action log
-- (pull request #13). The code before that step uses the grants removed here.
--
-- After this migration:
-- - only the trigger functions write the action log;
-- - only public.decide_action_proposal changes an action proposal.

drop policy if exists action_log_insert_own on public.action_log;
revoke insert on public.action_log from authenticated;

drop policy if exists action_proposals_update_own on public.action_proposals;
revoke update (status, result, decided_at) on public.action_proposals from authenticated;
revoke update on public.action_proposals from authenticated;
