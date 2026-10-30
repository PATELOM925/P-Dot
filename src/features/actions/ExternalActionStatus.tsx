"use client";

import { useState } from "react";
import { ApiError, errorMessage } from "@/lib/api-client";
import { EXTERNAL_ACTION_LEASE_SECONDS } from "@/lib/limits";
import type { ActionProposalDTO } from "@/types/api";
import { recoverAction } from "./api";
import { EXTERNAL_CHECK_PLACE } from "./format";

/**
 * An external action that has no stored outcome yet (decision 0014). Inside
 * the lease P-Dot may still be working on it. After the lease, a calendar
 * event can be checked again (Google refuses a second copy), and the user
 * says if an email was sent. P-Dot never sends an email again by itself.
 */
export function ExternalActionStatus({
  proposal,
  onUpdated,
  onUnauthorized,
}: {
  proposal: ActionProposalDTO & { payload: { kind: "send_email" | "create_calendar_event" } };
  onUpdated: (updated: ActionProposalDTO) => void;
  onUnauthorized?: () => void;
}) {
  const kind = proposal.payload.kind;
  const [askUser, setAskUser] = useState(kind === "send_email");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const started = proposal.executionStartedAt ? Date.parse(proposal.executionStartedAt) : Number.NaN;
  const [now] = useState(() => Date.now());
  const leaseOver = !Number.isFinite(started) || now - started > EXTERNAL_ACTION_LEASE_SECONDS * 1000;

  async function recover(answer?: "done" | "not_done") {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await recoverAction(proposal.id, answer);
      if (updated.status === "executing") setMessage("P-Dot still does not know if this was done.");
      onUpdated(updated);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized?.();
        return;
      }
      if (err instanceof ApiError && err.status === 409 && err.code === "conflict" && !answer) setAskUser(true);
      setMessage(errorMessage(err, "P-Dot could not check this. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="approval-outcome small stack" role="group" aria-label="Action in progress">
      {!leaseOver ? (
        <p>P-Dot is working on this. Check back in two minutes.</p>
      ) : askUser ? (
        <>
          <p>
            P-Dot does not know if this was done. Look in {EXTERNAL_CHECK_PLACE[kind]}, then tell P-Dot. P-Dot will not
            do it again by itself.
          </p>
          <div className="actions">
            <button type="button" className="button button-small" disabled={busy} onClick={() => void recover("done")}>
              It was done
            </button>
            <button type="button" className="button button-small" disabled={busy} onClick={() => void recover("not_done")}>
              It was not done
            </button>
          </div>
        </>
      ) : (
        <>
          <p>P-Dot does not know yet if this event was added. It can check again without adding a second copy.</p>
          <div className="actions">
            <button type="button" className="button button-small" disabled={busy} onClick={() => void recover()}>
              {busy ? "Checking…" : "Check again"}
            </button>
          </div>
        </>
      )}
      {message && (
        <p className="alert alert-warning small" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
