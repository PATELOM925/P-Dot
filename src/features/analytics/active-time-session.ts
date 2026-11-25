import { accrueVisibleActiveTime, isCurrentConsentStatusResponse, shouldAcquireActiveTimeLock, shouldRetryActiveTimeLock, supportsActiveTimeLock, takeActiveSample } from "./active-sample";

const LOCK_NAME = "pdot-product-analytics-active-time";
const TICK_MS = 15_000;

type TrackerWindow = Pick<Window, "addEventListener" | "removeEventListener" | "setInterval" | "clearInterval" | "setTimeout" | "clearTimeout">;
type TrackerDocument = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
type TrackerFetch = typeof fetch;
type ActiveTimeLockManager = { request: (name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void> | void) => Promise<unknown> };

export function startActiveTimeSession(screen: () => string, browser: {
  window: TrackerWindow;
  document: TrackerDocument;
  locks?: ActiveTimeLockManager;
  fetch: TrackerFetch;
}): () => void {
  let disposed = false;
  let enabled = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let retryTimer: number | null = null;
  let lastInteraction: number | null = null;

  const stopLock = () => {
    controller?.abort();
    controller = null;
    if (retryTimer !== null) browser.window.clearTimeout(retryTimer);
    retryTimer = null;
  };

  const acquire = () => {
    if (!shouldAcquireActiveTimeLock({ enabled, visible: browser.document.visibilityState === "visible", disposed, hasController: controller !== null })) return;
    const locks = browser.locks;
    if (!locks || !supportsActiveTimeLock(locks)) return;
    const lockController = new AbortController();
    controller = lockController;
    let acquired = false;
    let failed = false;
    let activeMs = 0;
    let previous = Date.now();
    let sending = false;
    const flush = async () => {
      const sample = takeActiveSample(activeMs);
      if (!sample || sending) return;
      sending = true;
      try {
        const response = await browser.fetch("/api/analytics/active", {
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
      activeMs = accrueVisibleActiveTime(activeMs, elapsed, lastInteraction, now, browser.document.visibilityState === "visible");
      previous = now;
      void flush();
    };
    const onInteraction = () => { lastInteraction = Date.now(); };
    const events = ["pointerdown", "keydown", "touchstart", "scroll"] as const;
    void locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock || lockController.signal.aborted || controller !== lockController) return;
      acquired = true;
      previous = Date.now();
      events.forEach((name) => browser.window.addEventListener(name, onInteraction, { passive: true }));
      const timer = browser.window.setInterval(tick, TICK_MS);
      try {
        await new Promise<void>((resolve) => lockController.signal.addEventListener("abort", () => resolve(), { once: true }));
      } finally {
        browser.window.clearInterval(timer);
        events.forEach((name) => browser.window.removeEventListener(name, onInteraction));
      }
    }).catch(() => { failed = true; }).finally(() => {
      if (controller !== lockController) return;
      controller = null;
      if (shouldRetryActiveTimeLock({ acquired, failed, enabled, visible: browser.document.visibilityState === "visible", disposed })) retryTimer = browser.window.setTimeout(acquire, 1_000);
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
  const onConsent: EventListener = (event) => setEnabled((event as CustomEvent<boolean>).detail === true);
  const onVisibility = () => {
    if (browser.document.visibilityState === "visible") acquire();
    else stopLock();
  };
  browser.window.addEventListener("pdot-analytics-consent", onConsent);
  browser.document.addEventListener("visibilitychange", onVisibility);
  const statusGeneration = generation;
  void browser.fetch("/api/analytics/status", { cache: "no-store" }).then(async (response) => {
    if (!response.ok) return;
    const data = await response.json() as { available: boolean; enabled: boolean };
    if (isCurrentConsentStatusResponse(statusGeneration, generation, disposed)) setEnabled(data.available && data.enabled);
  }).catch(() => {});
  return () => {
    disposed = true;
    stopLock();
    browser.window.removeEventListener("pdot-analytics-consent", onConsent);
    browser.document.removeEventListener("visibilitychange", onVisibility);
  };
}
