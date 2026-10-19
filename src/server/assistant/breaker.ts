import "server-only";

/**
 * A soft circuit breaker for each model. After `threshold` failures in a row,
 * the executor skips that model for `cooldownMs`. After the cooldown, the next
 * request tries the model again, and one success closes the breaker.
 *
 * Best effort only: the state lives in the memory of one Workers isolate, so
 * each isolate learns on its own and forgets when it is recycled. It never
 * makes a limit or stores data. It only saves time on a model that is down.
 */
export interface CircuitBreaker {
  isOpen(model: string, now: number): boolean;
  recordFailure(model: string, now: number): void;
  recordSuccess(model: string): void;
}

export function createCircuitBreaker(options: { threshold: number; cooldownMs: number }): CircuitBreaker {
  const state = new Map<string, { failures: number; openUntil: number }>();
  return {
    isOpen(model, now) {
      const entry = state.get(model);
      return entry !== undefined && entry.openUntil > now;
    },
    recordFailure(model, now) {
      const entry = state.get(model) ?? { failures: 0, openUntil: 0 };
      entry.failures += 1;
      if (entry.failures >= options.threshold) entry.openUntil = now + options.cooldownMs;
      state.set(model, entry);
    },
    recordSuccess(model) {
      state.delete(model);
    },
  };
}

/** Defaults: 3 failures in a row open the breaker for 30 seconds. */
export const BREAKER_DEFAULTS = { threshold: 3, cooldownMs: 30_000 } as const;
