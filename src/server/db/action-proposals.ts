import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { actionPayloadSchema, actionSummarySchema } from "@/lib/schemas";
import type { ActionPayload, ActionProposalDTO, ActionStatus } from "@/types/api";
import { RepositoryError } from "./conversations";

/**
 * Action proposals (decision 0009). The assistant proposes an action; it runs
 * only after the user approves it. Every method filters by the authenticated
 * user's ID, and RLS enforces the same rule in the database.
 *
 * The database lets the user change only status, result and decided_at, so the
 * stored payload never changes after the proposal is created.
 */
export interface NewActionProposal {
  conversationId: string | null;
  payload: ActionPayload;
  summary: string;
}

export interface ActionProposalRepository {
  /** Inserts with status "proposed". Throws when the payload or summary is invalid. */
  createProposal(userId: string, proposal: NewActionProposal): Promise<ActionProposalDTO>;
  /** Newest first. `status` filters; undefined returns every status. Rows whose payload does not parse are left out. */
  listProposals(userId: string, status: ActionStatus | undefined, limit: number): Promise<ActionProposalDTO[]>;
  /** Returns null when the proposal is missing, belongs to another user, or its stored payload does not parse. */
  getProposal(userId: string, proposalId: string): Promise<ActionProposalDTO | null>;
  /**
   * One conditional update: moves a "proposed" proposal to "approved" or
   * "rejected". Returns null when it was not "proposed" (already decided, or
   * not the user's), so a second decision can never run the action again.
   */
  claimForDecision(
    userId: string,
    proposalId: string,
    status: "approved" | "rejected",
  ): Promise<ActionProposalDTO | null>;
  /** Moves an "approved" proposal to "executed" or "failed" and stores the result. Throws when no row matches. */
  finish(
    userId: string,
    proposalId: string,
    status: "executed" | "failed",
    result: Record<string, string | number | boolean | null>,
  ): Promise<ActionProposalDTO>;
}

const ACTION_STATUSES = ["proposed", "approved", "rejected", "executed", "failed"] as const;
const ACTION_KINDS = ["create_task", "create_reminder", "save_memory"] as const;

const proposalRow = z.object({
  id: z.string(),
  conversation_id: z.string().nullable(),
  kind: z.enum(ACTION_KINDS),
  payload: z.unknown(),
  summary: z.string(),
  status: z.enum(ACTION_STATUSES),
  result: z.unknown(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
});

const resultValues = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

const PROPOSAL_COLUMNS = "id, conversation_id, kind, payload, summary, status, result, created_at, decided_at";

/**
 * Maps a row to a DTO. Returns null when the row or its stored payload does
 * not parse, or when the payload kind differs from the row's kind. Such a row
 * is never executed.
 */
function toProposal(row: unknown): ActionProposalDTO | null {
  const parsed = proposalRow.safeParse(row);
  if (!parsed.success) return null;
  const payload = actionPayloadSchema.safeParse(parsed.data.payload);
  if (!payload.success || payload.data.kind !== parsed.data.kind) return null;
  const result = resultValues.nullable().safeParse(parsed.data.result);
  return {
    id: parsed.data.id,
    conversationId: parsed.data.conversation_id,
    payload: payload.data,
    summary: parsed.data.summary,
    status: parsed.data.status,
    result: result.success ? result.data : null,
    createdAt: parsed.data.created_at,
    decidedAt: parsed.data.decided_at,
  };
}

/** For writes: a row that was just written must map. If it does not, fail loudly. */
function toWrittenProposal(row: unknown, operation: string): ActionProposalDTO {
  const dto = toProposal(row);
  if (!dto) throw new RepositoryError(operation);
  return dto;
}

export function createActionProposalRepository(supabase: SupabaseClient): ActionProposalRepository {
  return {
    async createProposal(userId, proposal) {
      // Validate before the insert. Throws a ZodError on invalid input.
      const payload = actionPayloadSchema.parse(proposal.payload);
      const summary = actionSummarySchema.parse(proposal.summary);
      const { data, error } = await supabase
        .from("action_proposals")
        .insert({
          user_id: userId,
          conversation_id: proposal.conversationId,
          kind: payload.kind,
          payload,
          summary,
          status: "proposed",
        })
        .select(PROPOSAL_COLUMNS)
        .single();
      if (error || !data) throw new RepositoryError("createActionProposal");
      return toWrittenProposal(data, "createActionProposal");
    },

    async listProposals(userId, status, limit) {
      let query = supabase.from("action_proposals").select(PROPOSAL_COLUMNS).eq("user_id", userId);
      if (status) query = query.eq("status", status);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
      if (error) throw new RepositoryError("listActionProposals");
      return (data ?? []).map(toProposal).filter((dto): dto is ActionProposalDTO => dto !== null);
    },

    async getProposal(userId, proposalId) {
      const { data, error } = await supabase
        .from("action_proposals")
        .select(PROPOSAL_COLUMNS)
        .eq("id", proposalId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new RepositoryError("getActionProposal");
      return data ? toProposal(data) : null;
    },

    async claimForDecision(userId, proposalId, status) {
      const { data, error } = await supabase
        .from("action_proposals")
        .update({ status, decided_at: new Date().toISOString() })
        .eq("id", proposalId)
        .eq("user_id", userId)
        .eq("status", "proposed")
        .select(PROPOSAL_COLUMNS)
        .maybeSingle();
      if (error) throw new RepositoryError("claimActionProposal");
      return data ? toWrittenProposal(data, "claimActionProposal") : null;
    },

    async finish(userId, proposalId, status, result) {
      const { data, error } = await supabase
        .from("action_proposals")
        .update({ status, result })
        .eq("id", proposalId)
        .eq("user_id", userId)
        .eq("status", "approved")
        .select(PROPOSAL_COLUMNS)
        .maybeSingle();
      if (error || !data) throw new RepositoryError("finishActionProposal");
      return toWrittenProposal(data, "finishActionProposal");
    },
  };
}
