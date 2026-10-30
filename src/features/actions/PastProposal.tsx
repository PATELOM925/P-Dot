import Link from "next/link";
import type { ActionProposalDTO } from "@/types/api";
import { KIND_LABELS, KIND_RESULT_LINKS, pastProposalView } from "./format";

/**
 * A suggestion decided before this page was opened, shown under the reply that
 * made it. It shows P-Dot's summary and the decision, not the details: an
 * approval may have been edited, and the stored payload is the original.
 */
export function PastProposal({ proposal }: { proposal: ActionProposalDTO }) {
  const view = pastProposalView(proposal);
  if (!view) return null;
  const result = KIND_RESULT_LINKS[proposal.payload.kind];
  return (
    <li className="past-action">
      <span className={`status-pill ${view.pill}`}>{view.label}</span>
      <span className="past-action-body">
        <span className="past-action-summary">{proposal.summary}</span>
        <span className="hint">
          {KIND_LABELS[proposal.payload.kind]} · {view.note}
          {view.showResult && (
            <>
              {" "}
              <Link href={result.href}>{result.label}</Link>
            </>
          )}
        </span>
      </span>
    </li>
  );
}
