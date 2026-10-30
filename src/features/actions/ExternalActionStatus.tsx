"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError, errorMessage } from "@/lib/api-client";
import { EXTERNAL_ACTION_LEASE_SECONDS } from "@/lib/limits";
import type { ActionProposalDTO } from "@/types/api";
import { recoverAction } from "./api";
import { EXTERNAL_CHECK_PLACE, leaseRemainingMs, leaseTimerDelayMs } from "./format";

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
  const [reconnect, setReconnect] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const leaseOver = leaseRemainingMs(proposal.executionStartedAt, now, EXTERNAL_ACTION_LEASE_SECONDS) === 0;

  // Re-render when the lease ends, so the recovery controls appear on an open page. The delay is
  // measured from the clock at scheduling time, and a new start time (a renewed lease) schedules again.
  useEffect(() => {
    const delay = leaseTimerDelayMs(proposal.executionStartedAt, Date.now(), EXTERNAL_ACTION_LEASE_SECONDS);
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [proposal.executionStartedAt]);

  async function recover(answer?: "done" | "not_done") {
    setBusy(true);
    setMessage(null);
    setReconnect(false);
    try {
      const updated = await recoverAction(proposal.id, answer);
      if (updated.status === "executing") setMessage("P-Dot still does not know if this was done.");
      onUpdated(updated);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized?.();
        return;
      }
      if (err instanceof ApiError && err.code === "reconnect_required") {
        setReconnect(true);
        return;
      }
      if (err instanceof ApiError && err.status === 409 && err.code === "conflict" && !answer) setAskUser(true);
      setMessage(errorMessage(err, "P-Dot could not check this. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="approval-pending small stack" role="group" aria-label="Action in progress">
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
      {reconnect && (
        <p className="alert alert-warning small" role="status">
          Connect Google again to finish checking. <Link href="/connectors#google">Open Connectors</Link>
        </p>
      )}
      {message && (
        <p className="alert alert-warning small" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
