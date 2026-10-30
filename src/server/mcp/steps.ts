import "server-only";

// A connector tool that makes more than one remote call, in an order written
// in code (decision 0020, "GitHub requests in plain words"). The model gives
// only the tool's checked arguments. Every remote call goes through the same
// pin check and the same per-turn limits as a one-call tool.

/** One remote tool that a catalog tool calls, and the argument names it sends. Pinned at Connect. */
export interface RemoteStep {
  remote: string;
  sends: readonly string[];
}

export interface StepCaller {
  /**
   * Calls one remote tool of the app, which must be in the tool's steps. The
   * same call with the same arguments runs once in a turn. Throws StepStop
   * with a text for the model when the call cannot run or the app reports an error.
   */
  call(remote: string, args: Record<string, unknown>): Promise<{ json: unknown; text: string }>;
  /** Lets a later tool in this turn use this ID under the outbound ID rule. Only for IDs from a typed field of a result. */
  allowId(id: string): void;
}

/** Ends a multi-call tool with this text as its result. Nothing more is read. */
export class StepStop extends Error {
  constructor(readonly text: string) {
    super("step_stop");
  }
}
