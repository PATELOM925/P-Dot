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
        const label = `${prefix}.${name}${options.detail ? `:${options.detail(name, args)}` : ""}`;
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

export interface SweepCase {
  step: number;
  fault: WriteFault;
  label: string;
}

/**
 * Runs `scenario` once with no fault to count its writes, then once for each
 * write and each fault. The scenario builds fresh fakes, wraps them with the
 * given WriteFaults, sends the request, calls `disarm()`, then recovers and
 * asserts. Returns the cases that were run. Runs every case, then fails with
 * a list of each case that failed or whose planned fault did not fire.
 */
export async function sweepWriteFaults(
  scenario: (faults: WriteFaults, sweepCase: SweepCase | null) => Promise<void>,
  faults: readonly WriteFault[] = WRITE_FAULTS,
): Promise<SweepCase[]> {
  const dry = new WriteFaults();
  await scenario(dry, null);
  if (dry.calls.length === 0) throw new Error("The scenario made no counted write.");

  const cases: SweepCase[] = [];
  const failures: string[] = [];
  for (const [index, label] of dry.calls.entries()) {
    for (const fault of faults) {
      const sweepCase = { step: index + 1, fault, label };
      const run = new WriteFaults().fail(fault, sweepCase.step);
      try {
        await scenario(run, sweepCase);
        if (run.fired.length !== 1) throw new Error("the planned fault did not fire");
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        const name = describeCase(sweepCase);
        failures.push(message.startsWith(name) ? message : `${name}: ${message}`);
      }
      cases.push(sweepCase);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${cases.length} cases failed:\n${failures.join("\n")}`);
  }
  return cases;
}

export function describeCase(sweepCase: SweepCase | null): string {
  return sweepCase ? `${sweepCase.fault} write ${sweepCase.step} (${sweepCase.label})` : "no fault";
}
