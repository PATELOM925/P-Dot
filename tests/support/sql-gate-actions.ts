import { user, type SqlGate } from "./sql-gate";

/** Valid payloads for each action kind. */
export const TASK = { kind: "create_task", mode: "personal", title: "Pay the invoice" };
export const REMINDER = { kind: "create_reminder", mode: "work", title: "Call Sam", dueAt: "2026-10-30T17:00:00Z" };
export const MEMORY = { kind: "save_memory", mode: "personal", content: "Prefers short replies" };

/** What decide_action_proposal answers. */
export interface Decision {
  outcome: string;
  proposal: {
    id: string;
    status: string;
    payload: Record<string, unknown>;
    result: Record<string, unknown> | null;
    decided_by_function: boolean;
  } | null;
}

/** Inserts a proposed action as its owner, the way the app does. */
export async function propose(gate: SqlGate, owner: string, payload: Record<string, unknown>): Promise<string> {
  const result = await gate.as<{ id: string }>(
    user(owner),
    "insert into action_proposals (user_id, kind, payload, summary) values ($1, $2, $3::jsonb, 'Do it') returning id",
    [owner, payload.kind, JSON.stringify(payload)],
  );
  return result.rows[0]!.id;
}

/** Calls the real decide_action_proposal as `owner`. */
export async function decideAs(
  gate: SqlGate,
  owner: string,
  id: string,
  decision: string,
  payload?: unknown,
): Promise<Decision> {
  const result = await gate.as<{ r: Decision }>(
    user(owner),
    "select public.decide_action_proposal($1, $2, $3::jsonb) as r",
    [id, decision, payload === undefined ? null : JSON.stringify(payload)],
  );
  return result.rows[0]!.r;
}

/** The log events of one proposal, oldest first. */
export async function proposalEvents(gate: SqlGate, id: string): Promise<string[]> {
  const result = await gate.admin<{ event: string }>(
    "select event from action_log where proposal_id = $1 order by created_at",
    [id],
  );
  return result.rows.map((row) => row.event);
}
