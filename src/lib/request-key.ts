/** The header that carries the request key of a user action (decision 0012). */
export const REQUEST_KEY_HEADER = "Idempotency-Key";

/**
 * One request key for one user action. The key stays the same while the scope
 * (what the action is: its target and its text) stays the same, so a resend of
 * the same draft uses the same key. A changed scope gets a new key.
 */
export class RequestKey {
  private current: { scope: string; key: string } | null = null;

  constructor(private readonly newKey: () => string = () => crypto.randomUUID()) {}

  keyFor(scope: string): string {
    if (this.current?.scope !== scope) this.current = { scope, key: this.newKey() };
    return this.current.key;
  }

  /** The action is saved, or the server refused the key: the next action gets a new key. */
  clear(): void {
    this.current = null;
  }
}
