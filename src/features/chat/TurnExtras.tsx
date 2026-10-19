"use client";

import { ApprovalCard } from "@/features/actions/ApprovalCard";
import { PastProposal } from "@/features/actions/PastProposal";
import { MemorySuggestionCard } from "@/features/memory/MemorySuggestionCard";
import type { MemorySuggestion } from "@/features/memory/useMemorySuggestions";
import type { ActionProposalDTO, MemoryDTO } from "@/types/api";

/**
 * What P-Dot suggested in one turn, shown under its reply: actions waiting for
 * approval (or decided here) as cards, memories it suggested, and earlier
 * decisions as short lines.
 */
export function TurnExtras({
  proposals = [],
  suggestions = [],
  decidedHere,
  onDecided,
  onStale,
  onKept,
  onDropped,
  onUnauthorized,
}: {
  proposals?: ActionProposalDTO[];
  suggestions?: MemorySuggestion[];
  decidedHere: ReadonlySet<string>;
  onDecided: (updated: ActionProposalDTO) => void;
  onStale: (id: string) => void;
  onKept: (memory: MemoryDTO) => void;
  onDropped: (memory: MemoryDTO) => void;
  onUnauthorized: () => void;
}) {
  if (proposals.length === 0 && suggestions.length === 0) return null;
  const open = proposals.filter((p) => p.status === "proposed" || decidedHere.has(p.id));
  const past = proposals.filter((p) => p.status !== "proposed" && !decidedHere.has(p.id));

  return (
    <section className="turn-extras" aria-label="P-Dot's suggestions for this reply">
      {open.map((proposal) => (
        <ApprovalCard
          key={proposal.id}
          proposal={proposal}
          onDecided={onDecided}
          onStale={() => onStale(proposal.id)}
          onUnauthorized={onUnauthorized}
        />
      ))}
      {suggestions.map((suggestion) => (
        <MemorySuggestionCard
          key={suggestion.memory.id}
          suggestion={suggestion}
          onKept={onKept}
          onDropped={onDropped}
          onUnauthorized={onUnauthorized}
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
