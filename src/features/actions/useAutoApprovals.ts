"use client";

import { useEffect, useRef, useState } from "react";
import { turnStartFor } from "@/features/chat/placement";
import { ApiError } from "@/lib/api-client";
import { planAutoRun, type ApprovalMode } from "@/lib/approval-policy";
import type { ActionProposalDTO, MessageRole } from "@/types/api";
import { decideAction } from "./api";

export type AutoRunOutcome = "done" | "failed";

interface TurnMessage {
  id: string;
  role: MessageRole;
  createdAt: string;
  pending?: boolean;
}

export interface AutoView {
  /** Waiting proposals that Auto is approving now. */
  running: ActionProposalDTO[];
  /** Waiting proposals that still ask in Auto, with the reason for their card. */
  asks: Map<string, string>;
}

/**
 * What Auto does with one conversation's proposals. It acts only on turns the
 * user started while Auto was on (`autoTurns` holds their user message IDs),
 * and only while Auto is still on; the limit per reply counts what already ran.
 */
export function planAutoTurns(
  messages: TurnMessage[],
  proposals: ActionProposalDTO[],
  autoTurns: ReadonlySet<string>,
  mode: ApprovalMode,
  ran: ReadonlyMap<string, AutoRunOutcome>,
): AutoView {
  const view: AutoView = { running: [], asks: new Map() };
  if (mode !== "auto" || autoTurns.size === 0) return view;
  const byTurn = new Map<string, ActionProposalDTO[]>();
  for (const proposal of proposals) {
    const turn = turnStartFor(messages, proposal.createdAt);
    if (!turn || !autoTurns.has(turn)) continue;
    byTurn.set(turn, [...(byTurn.get(turn) ?? []), proposal]);
  }
  for (const list of byTurn.values()) {
    const plan = planAutoRun(list, mode, list.filter((p) => ran.has(p.id)).length);
    view.running.push(...plan.run);
    for (const [id, reason] of plan.ask) view.asks.set(id, reason);
  }
  return view;
}

/**
 * Approves, through the normal decision route, the proposals Auto may run.
 * The server still checks each one and runs it at most once; a refusal there
 * (already decided, or the run failed) reloads the list like a manual click.
 */
export function useAutoApprovals({
  mode,
  messages,
  proposals,
  autoTurns,
  onDecided,
  onStale,
  onUnauthorized,
}: {
  mode: ApprovalMode;
  messages: TurnMessage[];
  proposals: ActionProposalDTO[];
  autoTurns: ReadonlySet<string>;
  onDecided: (updated: ActionProposalDTO) => void;
  onStale: (id: string) => void;
  onUnauthorized: () => void;
}): AutoView & { ran: ReadonlyMap<string, AutoRunOutcome> } {
  const [ran, setRan] = useState<ReadonlyMap<string, AutoRunOutcome>>(() => new Map());
  // Each proposal is sent at most once from this page, even if a render repeats.
  const attempted = useRef(new Set<string>());
  const view = planAutoTurns(messages, proposals, autoTurns, mode, ran);
  const running = view.running;

  useEffect(() => {
    for (const proposal of running) {
      if (attempted.current.has(proposal.id)) continue;
      attempted.current.add(proposal.id);
      decideAction(proposal.id, "approve").then(
        (updated) => {
          setRan((current) => new Map(current).set(updated.id, updated.status === "executed" ? "done" : "failed"));
          onDecided(updated);
        },
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 401) onUnauthorized();
          else onStale(proposal.id);
        },
      );
    }
  }, [running, onDecided, onStale, onUnauthorized]);

  return { ...view, ran };
}
