"use client";

import { useState } from "react";
import { getSupabaseConfig } from "@/lib/supabase-config";
import { isOutage, trialErrorMessage, UNAVAILABLE_MESSAGE } from "./errors";

/**
 * Starts a trial with a Supabase anonymous user (decision 0015). The browser
 * makes the call, so Supabase's per-IP limit counts each visitor's own IP, not
 * the Worker's. A browser that already has a session goes to chat and makes no
 * new user.
 */
export function TryWithoutAccount({ className = "button button-primary button-large" }: { className?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (pending) return;
    setPending(true);
    setError(null);
    const fail = (message: string) => {
      setError(message);
      setPending(false);
    };
    try {
      const { url, publishableKey } = getSupabaseConfig();
      const { createBrowserClient } = await import("@supabase/ssr");
      const supabase = createBrowserClient(url, publishableKey);
      // getUser asks the Auth server, so a stale cookie of a deleted user does not count as a session.
      const { data, error: userError } = await supabase.auth.getUser();
      if (userError && isOutage(userError)) return fail(UNAVAILABLE_MESSAGE);
      if (!data.user) {
        const { error: signInError } = await supabase.auth.signInAnonymously();
        if (signInError) return fail(trialErrorMessage(signInError));
      }
      // A full page load, so the server reads the new session cookies. The button stays disabled until then.
      window.location.assign("/chat");
    } catch {
      fail(UNAVAILABLE_MESSAGE);
    }
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
