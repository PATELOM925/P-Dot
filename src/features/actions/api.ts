import { getJson, sendJson } from "@/lib/api-client";
import type { ActionLogEntryDTO, ActionPayload, ActionProposalDTO, ActionStatus } from "@/types/api";

export async function fetchActions(status?: ActionStatus, signal?: AbortSignal): Promise<ActionProposalDTO[]> {
  const query = status ? `?status=${status}` : "";
  return (await getJson<{ actions: ActionProposalDTO[] }>(`/api/actions${query}`, signal)).actions;
}

/** Approve (optionally with an edited payload of the same kind) or reject. Returns the proposal after it ran. */
export async function decideAction(
  id: string,
  decision: "approve" | "reject",
  payload?: ActionPayload,
): Promise<ActionProposalDTO> {
  return sendJson<ActionProposalDTO>(`/api/actions/${encodeURIComponent(id)}/decision`, "POST", {
    decision,
    ...(payload ? { payload } : {}),
  });
}

/**
 * For an external action that stays "executing" (decision 0014). No answer:
 * P-Dot checks again (calendar only). An answer: the user says if it happened.
 */
export async function recoverAction(id: string, answer?: "done" | "not_done"): Promise<ActionProposalDTO> {
  return sendJson<ActionProposalDTO>(`/api/actions/${encodeURIComponent(id)}/recover`, "POST", answer ? { answer } : {});
}

export async function fetchActionLog(signal?: AbortSignal): Promise<ActionLogEntryDTO[]> {
  return (await getJson<{ entries: ActionLogEntryDTO[] }>("/api/action-log", signal)).entries;
}
