"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { takeActiveSample } from "./active-sample";

export function ActiveTimeTracker() {
  const pathname = usePathname();
  useEffect(() => {
    let cancelled = false;
    let trackingEnabled = false;
    let stop: (() => void) | undefined;
    let unlock: (() => void) | undefined;
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
      trackingEnabled = true;
      const release = new Promise<void>((resolve) => { unlock = resolve; });
      const begin = () => {
        if (cancelled || !trackingEnabled) return;
        let lastActivity = Date.now();
        let activeMs = 0;
        let previous = Date.now();
        let sending = false;
        const mark = () => { lastActivity = Date.now(); };
        const visibilityChanged = () => {
          previous = Date.now();
          lastActivity = previous;
          if (document.visibilityState !== "visible") {
            stop?.();
            stop = undefined;
          } else if (!stop) {
            window.setTimeout(startTracking, 50);
          }
        };
        const screen = (): string => {
          if (pathname.startsWith("/today")) return "today";
          if (pathname.startsWith("/connectors")) return "connectors";
          if (pathname.startsWith("/memory")) return "memory";
          if (pathname.startsWith("/activity")) return "activity";
          if (pathname.startsWith("/settings")) return "settings";
          return "chat";
        };
        const flush = async () => {
          const sample = takeActiveSample(activeMs);
          if (!sample || sending) return;
          activeMs = sample.remainingMs;
          sending = true;
          try {
            await fetch("/api/analytics/active", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ seconds: sample.seconds, screen: screen() }),
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
        const cleanup = () => {
          window.clearInterval(timer);
          activeMs = 0;
          events.forEach((name) => window.removeEventListener(name, mark));
          document.removeEventListener("visibilitychange", visibilityChanged);
        };
        stop = () => { trackingEnabled = false; cleanup(); unlock?.(); };
      };
      stop = () => { trackingEnabled = false; unlock?.(); };
      if (navigator.locks) {
        void navigator.locks.request("pdot-analytics-active", { ifAvailable: true }, async (lock) => {
          if (!lock || cancelled || !trackingEnabled) return;
          begin();
          await release;
        }).catch(() => {}).finally(() => { stop = undefined; });
      } else {
        stop = undefined;
      }
    }
    return () => { cancelled = true; window.removeEventListener("pdot-analytics-consent", consentChanged); stop?.(); };
  }, [pathname]);
  return null;
}
