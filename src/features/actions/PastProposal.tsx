import Link from "next/link";
import type { ActionProposalDTO, ActionStatus } from "@/types/api";
import { KIND_LABELS, KIND_RESULT_LINKS } from "./format";

const PAST: Record<Exclude<ActionStatus, "proposed">, { label: string; pill: string; note: string }> = {
  approved: { label: "Running", pill: "status-approved", note: "You approved it. It is still running." },
  executed: { label: "Done", pill: "status-executed", note: "You approved it." },
  rejected: { label: "Cancelled", pill: "status-rejected", note: "You cancelled it. Nothing was changed." },
  failed: { label: "Failed", pill: "status-failed", note: "You approved it, but it could not be completed." },
};

/**
 * A suggestion decided before this page was opened, shown under the reply that
 * made it. It shows P-Dot's summary and the decision, not the details: an
 * approval may have been edited, and the stored payload is the original.
 */
export function PastProposal({ proposal }: { proposal: ActionProposalDTO }) {
  if (proposal.status === "proposed") return null;
  const view = PAST[proposal.status];
  const result = KIND_RESULT_LINKS[proposal.payload.kind];
  return (
    <li className="past-action">
      <span className={`status-pill ${view.pill}`}>{view.label}</span>
      <span className="past-action-body">
        <span className="past-action-summary">{proposal.summary}</span>
        <span className="hint">
          {KIND_LABELS[proposal.payload.kind]} · {view.note}
          {proposal.status === "executed" && (
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
