"use client";

import { useRef, useState } from "react";
import { getSupabaseConfig } from "@/lib/supabase-config";
import { UNAVAILABLE_MESSAGE } from "./errors";
import { startTrial } from "./start-trial";

/**
 * Starts a trial with a Supabase anonymous user (decision 0015). The browser
 * makes the call, so Supabase's per-IP limit counts each visitor's own IP, not
 * the Worker's. The cookie-backed client writes the session where the server
 * reads it.
 */
export function TryWithoutAccount({ className = "button button-primary button-large" }: { className?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not state: two clicks in one frame both see the same state.
  const started = useRef(false);

  async function start() {
    if (started.current) return;
    started.current = true;
    setPending(true);
    setError(null);
    let message = UNAVAILABLE_MESSAGE;
    try {
      const { url, publishableKey } = getSupabaseConfig();
      const { createBrowserClient } = await import("@supabase/ssr");
      const result = await startTrial(createBrowserClient(url, publishableKey).auth);
      if (result.ok) {
        // The button stays disabled until the page changes.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load makes the server read the new session cookies
        window.location.assign("/chat");
        return;
      }
      message = result.message;
    } catch {
      // Missing settings or a failed import: the unavailable message.
    }
    setError(message);
    setPending(false);
    started.current = false;
  }

  return (
    <div className="try-trial">
      <button type="button" className={className} disabled={pending} onClick={() => void start()}>
        {pending ? "Starting your trial…" : "Try P-Dot now, no account"}
      </button>
      {error && (
        <p className="alert alert-error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
