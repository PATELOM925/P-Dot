const ACTIVE_SAMPLE_MS = 30_000;

export function takeActiveSample(activeMs: number): { seconds: 30; remainingMs: number } | null {
  if (!Number.isFinite(activeMs) || activeMs < ACTIVE_SAMPLE_MS) return null;
  return { seconds: 30, remainingMs: activeMs - ACTIVE_SAMPLE_MS };
}
