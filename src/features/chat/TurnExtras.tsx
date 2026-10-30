"use client";

import { ApprovalCard } from "@/features/actions/ApprovalCard";
import { AutoRanProposal } from "@/features/actions/AutoRanProposal";
import { needsUser } from "@/features/actions/format";
import { PastProposal } from "@/features/actions/PastProposal";
import type { AutoRunOutcome } from "@/features/actions/useAutoApprovals";
import { MemorySuggestionCard } from "@/features/memory/MemorySuggestionCard";
import type { MemorySuggestion } from "@/features/memory/useMemorySuggestions";
import { ALWAYS_ASK_REASONS, type ApprovalMode } from "@/lib/approval-policy";
import type { ActionProposalDTO, MemoryDTO } from "@/types/api";

/**
 * What P-Dot suggested in one turn, shown under its reply: what Auto mode did
 * on its own (with Undo), actions waiting for approval (or decided here) as
 * cards, memories it suggested, and earlier decisions as short lines.
 */
export function TurnExtras({
  proposals = [],
  suggestions = [],
  approvalMode,
  decidedHere,
  autoRunning,
  autoRan,
  askReasons,
  onDecided,
  onStale,
  onKept,
  onDropped,
  onUnauthorized,
}: {
  proposals?: ActionProposalDTO[];
  suggestions?: MemorySuggestion[];
  approvalMode: ApprovalMode;
  decidedHere: ReadonlySet<string>;
  /** Waiting proposals Auto mode is approving now. */
  autoRunning: ReadonlySet<string>;
  /** Proposals Auto mode approved from this page. */
  autoRan: ReadonlyMap<string, AutoRunOutcome>;
  /** In Auto mode: why a waiting proposal still asks. */
  askReasons: ReadonlyMap<string, string>;
  onDecided: (updated: ActionProposalDTO) => void;
  onStale: (id: string) => void;
  onKept: (memory: MemoryDTO) => void;
  onDropped: (memory: MemoryDTO) => void;
  onUnauthorized: () => void;
}) {
  if (proposals.length === 0 && suggestions.length === 0) return null;
  const isAuto = (p: ActionProposalDTO) => autoRunning.has(p.id) || autoRan.get(p.id) === "done";
  const auto = proposals.filter(isAuto);
  const open = proposals.filter((p) => !isAuto(p) && (needsUser(p) || decidedHere.has(p.id)));
  const past = proposals.filter((p) => !isAuto(p) && !needsUser(p) && !decidedHere.has(p.id));

  return (
    <section className="turn-extras" aria-label="P-Dot's suggestions for this reply">
      {auto.length > 0 && (
        <ul className="past-actions" aria-label="Done on its own in Auto mode">
          {auto.map((proposal) => (
            <AutoRanProposal key={proposal.id} proposal={proposal} running={autoRunning.has(proposal.id)} />
          ))}
        </ul>
      )}
      {open.map((proposal) => (
        <ApprovalCard
          key={proposal.id}
          proposal={proposal}
          onDecided={onDecided}
          onStale={() => onStale(proposal.id)}
          onUnauthorized={onUnauthorized}
          askReason={askReasons.get(proposal.id)}
        />
      ))}
      {suggestions.map((suggestion) => (
        <MemorySuggestionCard
          key={suggestion.memory.id}
          suggestion={suggestion}
          onKept={onKept}
          onDropped={onDropped}
          onUnauthorized={onUnauthorized}
          askReason={approvalMode === "auto" ? ALWAYS_ASK_REASONS.store_personal : undefined}
        />
      ))}
      {past.length > 0 && (
        <ul className="past-actions" aria-label="Earlier decisions on P-Dot's suggestions">
          {past.map((proposal) => (
            <PastProposal key={proposal.id} proposal={proposal} />
          ))}
        </ul>
      )}
    </section>
  );
}
