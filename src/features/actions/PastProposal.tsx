import Link from "next/link";
import type { ActionProposalDTO, ActionStatus } from "@/types/api";
import { KIND_LABELS, KIND_RESULT_LINKS } from "./format";

// "Approved" rather than "you approved": until the server records who decided (decision 0011),
// an approval made by Auto mode looks the same as one made with a click.
const PAST: Record<Exclude<ActionStatus, "proposed">, { label: string; pill: string; note: string }> = {
  approved: { label: "Running", pill: "status-approved", note: "Approved. It is still running." },
  executed: { label: "Done", pill: "status-executed", note: "Approved and done." },
  rejected: { label: "Cancelled", pill: "status-rejected", note: "You cancelled it. Nothing was changed." },
  failed: { label: "Failed", pill: "status-failed", note: "Approved, but it could not be completed." },
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
