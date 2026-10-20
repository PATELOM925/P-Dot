-- Older action proposals left 'approved' (decision 0009). Run in the Supabase
-- SQL editor as the database owner, for one user at a time. Replace $1 with
-- the user ID, $2 with the proposal ID and $3 with the ID of the row the user
-- confirmed. tests/integration/sql-gate.test.ts runs these exact statements.

-- name: find_approved (read-only)
select id, kind, payload, decided_at
from public.action_proposals
where user_id = $1 and status = 'approved'
order by decided_at;

-- name: find_reminder (read-only)
select r.id, r.title, r.due_at, r.created_at
from public.reminders r
where r.user_id = $1 and r.proposal_id = $2;

-- name: list_tasks_near_decision (read-only)
select t.id, t.title, t.mode, t.done, t.created_at
from public.tasks t
join public.action_proposals p on p.id = $2 and p.user_id = $1
where t.user_id = $1
  and t.created_at between p.decided_at - interval '1 minute' and p.decided_at + interval '10 minutes'
order by t.created_at;

-- name: list_memories_near_decision (read-only)
select m.id, m.content, m.mode, m.created_at
from public.memories m
join public.action_proposals p on p.id = $2 and p.user_id = $1
where m.user_id = $1 and m.source = 'assistant'
  and m.created_at between p.decided_at - interval '1 minute' and p.decided_at + interval '10 minutes'
order by m.created_at;

-- name: confirm_executed (writes one row; only after the user confirms the row)
update public.action_proposals p
set status = 'executed',
    result = jsonb_build_object(
      case p.kind when 'create_task' then 'taskId' when 'create_reminder' then 'reminderId' else 'memoryId' end,
      $3::text)
where p.id = $2 and p.user_id = $1 and p.status = 'approved'
  and (
    (p.kind = 'create_task' and exists (select 1 from public.tasks t where t.id::text = $3::text and t.user_id = $1))
    or (p.kind = 'create_reminder' and exists (select 1 from public.reminders r where r.id::text = $3::text and r.user_id = $1))
    or (p.kind = 'save_memory' and exists (select 1 from public.memories m where m.id::text = $3::text and m.user_id = $1))
  )
returning p.id;
