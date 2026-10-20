/**
 * Makes chosen writes of a multi-step request fail, to find rows left in an
 * in-between status. Writes are counted in call order across every wrapped
 * fake, starting at 1.
 *
 * - "refused": the write does not happen and the call fails.
 * - "lost": the write happens (it commits) and then the call fails, as if the
 *   response was lost on the way back.
 */
export type WriteFault = "refused" | "lost";

export const WRITE_FAULTS: readonly WriteFault[] = ["refused", "lost"];

type AsyncMethodKey<T> = {
  [K in keyof T]-?: T[K] extends (...args: never[]) => Promise<unknown> ? K : never;
}[keyof T];

export interface FiredFault {
  step: number;
  fault: WriteFault;
  label: string;
}

export class WriteFaultError extends Error {
  constructor(readonly fired: FiredFault) {
    super(`simulated ${fired.fault} write at step ${fired.step} (${fired.label})`);
    this.name = "WriteFaultError";
  }
}

export interface WrapOptions {
  /** Name used in `calls`. Default: the class name. */
  label?: string;
  /** Adds detail to the label, for example the table name. */
  detail?: (method: string, args: unknown[]) => string;
  /** The result of a failed call. Default: the call throws WriteFaultError. */
  failWith?: (error: WriteFaultError) => unknown;
}

export class WriteFaults {
  /** The label of every counted write, in order. */
  readonly calls: string[] = [];
  readonly fired: FiredFault[] = [];
  private readonly planned = new Map<number, WriteFault>();
  private counting = true;

  fail(fault: WriteFault, ...steps: number[]): this {
    for (const step of steps) this.planned.set(step, fault);
    return this;
  }

  /** The request under test is over: stop counting and make every later write work. */
  disarm(): void {
    this.counting = false;
    this.planned.clear();
  }

  wrap<T extends object>(target: T, methods: readonly AsyncMethodKey<T>[], options: WrapOptions = {}): T {
    const prefix = options.label ?? target.constructor.name;
    for (const method of methods) {
      const original = target[method] as (...args: unknown[]) => Promise<unknown>;
      const replacement = async (...args: unknown[]) => {
        if (!this.counting) return original.apply(target, args);
        const name = String(method);
        const detail = options.detail?.(name, args);
        const label = `${prefix}.${name}${detail ? `:${detail}` : ""}`;
        this.calls.push(label);
        const step = this.calls.length;
        const fault = this.planned.get(step);
        if (!fault) return original.apply(target, args);
        if (fault === "lost") await original.apply(target, args);
        const fired = { step, fault, label };
        this.fired.push(fired);
        const error = new WriteFaultError(fired);
        if (options.failWith) return options.failWith(error);
        throw error;
      };
      Object.defineProperty(target, method, { value: replacement, configurable: true, writable: true });
    }
    return target;
  }
}

/** The faults planned for one run, in step order. Empty for the run with no fault. */
export type SweepCase = readonly FiredFault[];

export interface SweepOptions {
  faults?: readonly WriteFault[];
  /** The most faults in one run. 2 reaches a write that only runs after an earlier write failed. */
  depth?: number;
  /** The sweep fails when it would run more cases than this. */
  maxCases?: number;
}

/**
 * Explores the writes of a scenario. The first run has no fault. After each
 * run, every write that run reached after its last fault becomes a new case
 * with one more fault (refused and lost), up to `depth` faults. So a write
 * that runs only on an error path (a fallback status write, a recovery write)
 * is also made to fail.
 *
 * The scenario builds fresh fakes, wraps them with the given WriteFaults, runs
 * the requests under test, calls `disarm()`, then recovers and asserts. Every
 * case runs. Then the sweep fails with a list of each case that failed, or
 * whose fired faults (step, fault and label) differ from the plan. Returns the
 * cases with faults.
 */
export async function sweepWriteFaults(
  scenario: (faults: WriteFaults, sweepCase: SweepCase) => Promise<void>,
  { faults = WRITE_FAULTS, depth = 2, maxCases = 500 }: SweepOptions = {},
): Promise<SweepCase[]> {
  const queue: SweepCase[] = [[]];
  const cases: SweepCase[] = [];
  const failures: string[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const plan = queue[index]!;
    const run = new WriteFaults();
    for (const planned of plan) run.fail(planned.fault, planned.step);
    try {
      await scenario(run, plan);
      if (run.fired.length < plan.length) throw new Error("a planned fault did not fire");
      if (describeCase(run.fired) !== describeCase(plan)) {
        throw new Error(`the faults that fired do not match the plan: ${describeCase(run.fired)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
      const name = describeCase(plan);
      failures.push(message.startsWith(name) ? message : `${name}: ${message}`);
    }
    if (plan.length === 0 && run.calls.length === 0) throw new Error("The scenario made no counted write.");
    if (plan.length > 0) cases.push(plan);

    if (plan.length >= depth) continue;
    for (let step = (plan.at(-1)?.step ?? 0) + 1; step <= run.calls.length; step += 1) {
      for (const fault of faults) queue.push([...plan, { step, fault, label: run.calls[step - 1]! }]);
    }
    if (queue.length - 1 > maxCases) {
      throw new Error(`The sweep needs more than ${maxCases} cases. Lower the depth or raise maxCases.`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${cases.length + 1} runs failed:\n${failures.join("\n")}`);
  }
  return cases;
}

export function describeCase(sweepCase: SweepCase): string {
  if (sweepCase.length === 0) return "no fault";
  return sweepCase.map((f) => `${f.fault} write ${f.step} (${f.label})`).join(" then ");
}

/** True when a case has a fault of this kind on a write with this label. */
export function hasFault(sweepCase: SweepCase, fault: WriteFault, label: string): boolean {
  return sweepCase.some((f) => f.fault === fault && f.label === label);
}
