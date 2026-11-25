"use client";

import { useEffect } from "react";

export function ActiveTimeTracker() {
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    const consentChanged = (event: Event) => {
      if ((event as CustomEvent<boolean>).detail) {
        if (!stop) startTracking();
      } else {
        stop?.();
        stop = undefined;
      }
    };
    window.addEventListener("pdot-analytics-consent", consentChanged);
    void fetch("/api/analytics/status", { cache: "no-store" }).then(async (response) => {
      if (!response.ok || cancelled) return;
      const data = await response.json() as { available: boolean; enabled: boolean };
      if (data.available && data.enabled && !cancelled) startTracking();
    }).catch(() => {});
    function startTracking() {
      let lastActivity = Date.now();
      let activeMs = 0;
      let previous = Date.now();
      let sending = false;
      const mark = () => { lastActivity = Date.now(); };
      const visibilityChanged = () => {
        previous = Date.now();
        lastActivity = previous;
      };
      const flush = async () => {
        const seconds = Math.floor(activeMs / 1000);
        if (seconds < 30 || sending) return;
        activeMs -= 30_000;
        sending = true;
        try {
          await fetch("/api/analytics/active", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ seconds: 30 }),
          });
        } catch {
          // Ignore analytics transport failures.
        } finally {
          sending = false;
        }
      };
      const tick = () => {
        const now = Date.now();
        const elapsed = Math.min(now - previous, 15_000);
        if (document.visibilityState === "visible" && now - lastActivity < 60_000) activeMs += elapsed;
        previous = now;
        void flush();
      };
      const timer = window.setInterval(tick, 15_000);
      const events = ["pointerdown", "keydown", "touchstart", "scroll"] as const;
      events.forEach((name) => window.addEventListener(name, mark, { passive: true }));
      document.addEventListener("visibilitychange", visibilityChanged);
      stop = () => {
        window.clearInterval(timer);
        activeMs = 0;
        events.forEach((name) => window.removeEventListener(name, mark));
        document.removeEventListener("visibilitychange", visibilityChanged);
      };
    }
    return () => { cancelled = true; window.removeEventListener("pdot-analytics-consent", consentChanged); stop?.(); };
  }, []);
  return null;
}
