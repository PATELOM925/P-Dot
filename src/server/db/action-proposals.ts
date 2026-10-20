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
 * Users cannot update a proposal. Only the database function
 * `decide_action_proposal` changes one: in one transaction it claims the
 * proposal, runs the action and stores the outcome, so an action runs at most
 * once and a stored outcome is always the real one.
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
  /**
   * Approves or rejects a proposal of the session user (the database reads
   * the user from the session, not from an argument). An approval runs the
   * action in the same transaction. `payload` is an edited payload of the
   * same kind. Throws RepositoryError when the call fails.
   */
  decide(proposalId: string, decision: "approve" | "reject", payload?: ActionPayload): Promise<DecisionResult>;
}

/**
 * What `decide_action_proposal` answered.
 * - not_found: no such proposal for this user (another user's proposal gives the same answer).
 * - already_decided: another decision came first. `proposal` holds the stored outcome.
 * - invalid: the stored or edited payload, or the decision, is not valid. Nothing changed.
 * - kind_mismatch: the edited payload has another kind. Nothing changed.
 * - rejected, executed, failed: the decision was stored. `failed` means the insert failed;
 *   `result` holds { error: "execution_failed", code } and nothing was created.
 */
export type DecisionOutcome =
  | "not_found"
  | "already_decided"
  | "invalid"
  | "kind_mismatch"
  | "rejected"
  | "executed"
  | "failed";

export interface DecisionResult {
  outcome: DecisionOutcome;
  /** Null for not_found, and when a stored row does not parse. */
  proposal: ActionProposalDTO | null;
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

const decisionResponse = z.object({
  outcome: z.enum(["not_found", "already_decided", "invalid", "kind_mismatch", "rejected", "executed", "failed"]),
  proposal: z.unknown(),
});

/** Outcomes that wrote the row just now. That row must map. */
const WRITTEN_OUTCOMES: ReadonlySet<DecisionOutcome> = new Set(["rejected", "executed", "failed"]);

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

    async decide(proposalId, decision, payload) {
      const { data, error } = await supabase.rpc("decide_action_proposal", {
        p_id: proposalId,
        p_decision: decision,
        p_payload: payload ?? null,
      });
      if (error) throw new RepositoryError("decideActionProposal");
      const parsed = decisionResponse.safeParse(data);
      if (!parsed.success) throw new RepositoryError("decideActionProposal");
      const { outcome, proposal } = parsed.data;
      if (proposal === null || proposal === undefined) return { outcome, proposal: null };
      return {
        outcome,
        proposal: WRITTEN_OUTCOMES.has(outcome)
          ? toWrittenProposal(proposal, "decideActionProposal")
          : toProposal(proposal),
      };
    },
  };
}
