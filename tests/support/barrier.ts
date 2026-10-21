/**
 * Holds a fake at a chosen step until the test releases it, so two requests
 * can overlap there. `reached` resolves when `count` callers wait.
 */
export function createBarrier(count = 1) {
  let release: () => void = () => {};
  let markReached: () => void = () => {};
  let waiting = 0;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  return {
    reached,
    release: () => release(),
    async wait(): Promise<void> {
      waiting += 1;
      if (waiting >= count) markReached();
      await opened;
    },
  };
}
