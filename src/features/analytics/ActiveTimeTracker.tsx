"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { accrueVisibleActiveTime, takeActiveSample } from "./active-sample";

const LOCK_NAME = "pdot-product-analytics-active-time";
const TICK_MS = 15_000;

export function ActiveTimeTracker() {
  const pathname = usePathname();
  useEffect(() => {
    let disposed = false;
    let enabled = false;
    let generation = 0;
    let controller: AbortController | null = null;
    let retryTimer: number | null = null;
    let lastInteraction: number | null = null;

    const screen = (): string => {
      if (pathname.startsWith("/today")) return "today";
      if (pathname.startsWith("/connectors")) return "connectors";
      if (pathname.startsWith("/memory")) return "memory";
      if (pathname.startsWith("/activity")) return "activity";
      if (pathname.startsWith("/settings")) return "settings";
      return "chat";
    };
    const stopLock = () => {
      controller?.abort();
      controller = null;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
    };

    const acquire = () => {
      if (disposed || !enabled || document.visibilityState !== "visible" || controller) return;
      const lockController = new AbortController();
      controller = lockController;
      let acquired = false;
      let activeMs = 0;
      let previous = Date.now();
      let sending = false;
      const flush = async () => {
        const sample = takeActiveSample(activeMs);
        if (!sample || sending) return;
        sending = true;
        try {
          const response = await fetch("/api/analytics/active", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ seconds: sample.seconds, screen: screen() }),
          });
          if (response.ok) activeMs = sample.remainingMs;
        } catch {
          // Analytics transport failures do not affect the app.
        } finally {
          sending = false;
        }
      };
      const tick = () => {
        const now = Date.now();
        const elapsed = Math.min(now - previous, TICK_MS);
        activeMs = accrueVisibleActiveTime(activeMs, elapsed, lastInteraction, now, document.visibilityState === "visible");
        previous = now;
        void flush();
      };
      const onInteraction = () => { lastInteraction = Date.now(); };
      const events = ["pointerdown", "keydown", "touchstart", "scroll"] as const;
      void navigator.locks.request(LOCK_NAME, { ifAvailable: true, signal: lockController.signal }, async (lock) => {
        if (!lock || lockController.signal.aborted) return;
        acquired = true;
        previous = Date.now();
        events.forEach((name) => window.addEventListener(name, onInteraction, { passive: true }));
        const timer = window.setInterval(tick, TICK_MS);
        try {
          await new Promise<void>((resolve) => lockController.signal.addEventListener("abort", () => resolve(), { once: true }));
        } finally {
          window.clearInterval(timer);
          events.forEach((name) => window.removeEventListener(name, onInteraction));
        }
      }).catch(() => {}).finally(() => {
        if (controller !== lockController) return;
        controller = null;
        if (!acquired && enabled && document.visibilityState === "visible" && !disposed) retryTimer = window.setTimeout(acquire, 1_000);
      });
    };

    const setEnabled = (next: boolean) => {
      generation += 1;
      enabled = next;
      if (!enabled) {
        lastInteraction = null;
        stopLock();
      } else acquire();
    };
    const onConsent = (event: Event) => setEnabled((event as CustomEvent<boolean>).detail === true);
    const onVisibility = () => {
      if (document.visibilityState === "visible") acquire();
      else stopLock();
    };
    window.addEventListener("pdot-analytics-consent", onConsent);
    document.addEventListener("visibilitychange", onVisibility);
    const statusGeneration = generation;
    void fetch("/api/analytics/status", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json() as { available: boolean; enabled: boolean };
      if (!disposed && generation === statusGeneration) setEnabled(data.available && data.enabled);
    }).catch(() => {});
    return () => {
      disposed = true;
      stopLock();
      window.removeEventListener("pdot-analytics-consent", onConsent);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pathname]);
  return null;
}
