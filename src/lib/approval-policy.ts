// When P-Dot may act without asking. Shared by the browser and the server, so
// the rules live in one place. No secrets here. See docs/decisions/0011-approval-modes.md.
import type { ActionKind, ActionProposalDTO } from "@/types/api";

/** "manual": every action waits for the user. "auto": safe actions run on their own; the rest still ask. */
export const APPROVAL_MODES = ["manual", "auto"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "manual";

export function parseApprovalMode(value: unknown): ApprovalMode {
  return value === "auto" || value === "manual" ? value : DEFAULT_APPROVAL_MODE;
}

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = { manual: "Ask first", auto: "Auto" };

/** What an action does to the user's data or the outside world. */
export type ActionEffect =
  | "create_own"
  | "change_own"
  | "store_personal"
  | "delete"
  | "external"
  | "read_sensitive"
  | "spend"
  | "settings";

/**
 * Every action kind must say what it does. A new kind does not compile until
 * it is listed here, so it can never run on its own by accident.
 */
export const ACTION_EFFECTS: Record<ActionKind, ActionEffect> = {
  create_task: "create_own",
  create_reminder: "create_own",
  save_memory: "store_personal",
};

/** Only these may run without asking, and only in Auto: adding to P-Dot's own lists, which the user can undo. */
const AUTO_EFFECTS: ReadonlySet<ActionEffect> = new Set(["create_own"]);

/** Why an action still asks in Auto, in the user's words. */
export const ALWAYS_ASK_REASONS: Record<Exclude<ActionEffect, "create_own">, string> = {
  change_own: "It changes something you already have.",
  store_personal: "It saves something about you.",
  delete: "It deletes or removes something.",
  external: "It acts outside P-Dot, such as sending a message or changing an account, calendar or device.",
  read_sensitive: "It reads private data, such as email or a connected account.",
  spend: "It spends money.",
  settings: "It changes a setting or a permission.",
};

/** In Auto, at most this many actions from one reply run on their own; the rest ask. */
export const MAX_AUTO_ACTIONS_PER_REPLY = 3;

export const AUTO_LIMIT_REASON = `P-Dot already did ${MAX_AUTO_ACTIONS_PER_REPLY} things on its own for this reply.`;

/** Whether this kind of action may run without asking in Auto. Never in "manual". */
export function mayRunOnItsOwn(kind: ActionKind, mode: ApprovalMode): boolean {
  return mode === "auto" && AUTO_EFFECTS.has(ACTION_EFFECTS[kind]);
}

/** Why this kind asks even in Auto, or null when it may run on its own. */
export function alwaysAskReason(kind: ActionKind): string | null {
  const effect = ACTION_EFFECTS[kind];
  return effect === "create_own" ? null : ALWAYS_ASK_REASONS[effect];
}

export interface AutoPlan {
  /** Waiting proposals to approve now, oldest first. */
  run: ActionProposalDTO[];
  /** Waiting proposals that still ask, with the reason shown on their card. */
  ask: Map<string, string>;
}

/**
 * Splits one reply's proposals in Auto mode. `alreadyRun` counts the ones that
 * ran on their own earlier for the same reply, so the limit holds across reloads.
 */
export function planAutoRun(proposals: ActionProposalDTO[], mode: ApprovalMode, alreadyRun = 0): AutoPlan {
  const plan: AutoPlan = { run: [], ask: new Map() };
  if (mode !== "auto") return plan;
  let budget = MAX_AUTO_ACTIONS_PER_REPLY - alreadyRun;
  for (const proposal of [...proposals].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    if (proposal.status !== "proposed") continue;
    const reason = alwaysAskReason(proposal.payload.kind);
    if (reason) plan.ask.set(proposal.id, reason);
    else if (budget > 0) {
      plan.run.push(proposal);
      budget -= 1;
    } else plan.ask.set(proposal.id, AUTO_LIMIT_REASON);
  }
  return plan;
}
