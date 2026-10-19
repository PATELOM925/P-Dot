"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api-client";
import type { ActionProposalDTO } from "@/types/api";
import { fetchActions } from "./api";
import { notifyActionsChanged } from "./events";

export interface ProposalsState {
  proposals: ActionProposalDTO[];
  state: "loading" | "ready" | "error";
  /** Decided in this view, so their cards stay open to show the outcome. */
  decidedHere: ReadonlySet<string>;
  /** After a card's decision came back. */
  decided: (updated: ActionProposalDTO) => void;
  /** After the server said the card's copy is out of date (decided elsewhere, or the run failed). */
  stale: (id: string) => void;
  reload: () => void;
}

/**
 * The signed-in user's action proposals (every status, newest first, up to
 * the API limit). Reloads when `refreshKey` changes, for example after a chat
 * reply, which may have come with new proposals. `enabled: false` loads nothing.
 */
export function useProposals({
  initial,
  refreshKey = 0,
  enabled = true,
  onUnauthorized,
}: {
  /** Server-rendered proposals, to avoid a loading flash. */
  initial?: ActionProposalDTO[];
  refreshKey?: string | number;
  enabled?: boolean;
  onUnauthorized?: () => void;
}): ProposalsState {
  const [proposals, setProposals] = useState<ActionProposalDTO[]>(initial ?? []);
  const [state, setState] = useState<ProposalsState["state"]>(initial ? "ready" : "loading");
  const [decidedHere, setDecidedHere] = useState<ReadonlySet<string>>(() => new Set());
  const [reloads, setReloads] = useState(0);
  const skipFirstLoad = useRef(initial !== undefined);

  useEffect(() => {
    if (!enabled) return;
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false;
      return;
    }
    const controller = new AbortController();
    fetchActions(undefined, controller.signal).then(
      (all) => {
        setProposals(all);
        setState("ready");
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401 && onUnauthorized) onUnauthorized();
        else setState("error");
      },
    );
    return () => controller.abort();
  }, [enabled, refreshKey, reloads, onUnauthorized]);

  const markDecided = useCallback((id: string) => {
    setDecidedHere((current) => (current.has(id) ? current : new Set(current).add(id)));
  }, []);

  const decided = useCallback(
    (updated: ActionProposalDTO) => {
      markDecided(updated.id);
      setProposals((list) => list.map((p) => (p.id === updated.id ? updated : p)));
      notifyActionsChanged();
    },
    [markDecided],
  );

  const stale = useCallback(
    (id: string) => {
      markDecided(id);
      setReloads((n) => n + 1);
      notifyActionsChanged();
    },
    [markDecided],
  );

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  return { proposals, state, decidedHere, decided, stale, reload };
}
