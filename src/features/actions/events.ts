// A browser event for "the list of action proposals may have changed", so the
// waiting-approvals badge can reload without the views knowing about it.
const EVENT = "pdot:actions-changed";

/** Call after a decision, or after a chat reply (which may have come with new proposals). */
export function notifyActionsChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function onActionsChanged(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
