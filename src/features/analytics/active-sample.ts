const ACTIVE_SAMPLE_MS = 30_000;
const IDLE_MS = 60_000;
const MAX_TICK_MS = 15_000;

export function supportsActiveTimeLock(locks: { request?: unknown } | undefined): boolean {
  return typeof locks?.request === "function";
}

export function shouldAcquireActiveTimeLock(state: {
  enabled: boolean;
  visible: boolean;
  disposed: boolean;
  hasController: boolean;
}): boolean {
  return state.enabled && state.visible && !state.disposed && !state.hasController;
}

export function shouldRetryActiveTimeLock(state: {
  acquired: boolean;
  failed: boolean;
  enabled: boolean;
  visible: boolean;
  disposed: boolean;
}): boolean {
  return !state.acquired && !state.failed && state.enabled && state.visible && !state.disposed;
}

export function isCurrentConsentStatusResponse(statusGeneration: number, currentGeneration: number, disposed: boolean): boolean {
  return !disposed && statusGeneration === currentGeneration;
}

export function accrueVisibleActiveTime(
  activeMs: number,
  elapsedMs: number,
  lastInteraction: number | null,
  now: number,
  visible: boolean,
): number {
  if (lastInteraction === null || !visible || now - lastInteraction >= IDLE_MS) return activeMs;
  return activeMs + Math.min(Math.max(elapsedMs, 0), MAX_TICK_MS);
}

export function takeActiveSample(activeMs: number): { seconds: 30; remainingMs: number } | null {
  if (!Number.isFinite(activeMs) || activeMs < ACTIVE_SAMPLE_MS) return null;
  return { seconds: 30, remainingMs: activeMs - ACTIVE_SAMPLE_MS };
}
