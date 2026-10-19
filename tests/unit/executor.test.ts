import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCircuitBreaker, type CircuitBreaker } from "@/server/assistant/breaker";
import {
  BudgetExhaustedError,
  EmptyReplyError,
  backoffMs,
  classifyError,
  executeRouted,
  newRouteReport,
  type AttemptBudget,
  type AttemptHold,
  type AttemptOutcome,
  type ExecutedChunk,
  type RouteReport,
} from "@/server/assistant/executor";
import type { TierPlan } from "@/server/assistant/tiers";
import { ProviderError } from "@/server/providers/errors";
import { FakeProvider, type FakeBehavior } from "../support/fake-provider";

const A = "model/a";
const B = "model/b";
const C = "model/c";

function fastPlan(overrides: Partial<TierPlan> = {}): TierPlan {
  return {
    tier: "fast",
    models: [A, B, C],
    maxOutputTokens: 256,
    thinkingBudgetTokens: 0,
    firstTokenTimeoutMs: 5_000,
    deadlineMs: 60_000,
    hedgeAfterMs: 1_500,
    triesPerModel: 2,
    maxAttempts: 4,
    ...overrides,
  };
}

const heavyPlan = (overrides: Partial<TierPlan> = {}) =>
  fastPlan({ tier: "heavy", models: [A, B], hedgeAfterMs: null, firstTokenTimeoutMs: 15_000, maxAttempts: 3, ...overrides });

/** Spend guard fake: one hold for each attempt; can refuse after `allow` holds. */
class FakeBudget implements AttemptBudget {
  reserved: { model: string; hold: AttemptHold }[] = [];
  settled: { model: string; hold: AttemptHold; outcome: AttemptOutcome }[] = [];
  constructor(private readonly allow = Infinity) {}

  async reserve(model: string) {
    if (this.reserved.length >= this.allow) return { allowed: false as const, limit: "day" as const };
    const hold = { reservationId: `r${this.reserved.length + 1}`, heldMicroUsd: 1_000 };
    this.reserved.push({ model, hold });
    return { allowed: true as const, hold };
  }

  settle(hold: AttemptHold, model: string, outcome: AttemptOutcome) {
    this.settled.push({ model, hold, outcome });
  }

  /** Every hold is settled exactly once. */
  expectAllSettledOnce() {
    const ids = this.settled.map((s) => s.hold.reservationId).sort();
    expect(ids).toEqual(this.reserved.map((r) => r.hold.reservationId).sort());
  }
}

interface RunResult {
  chunks: ExecutedChunk[];
  error: unknown;
  report: RouteReport;
  budget: FakeBudget;
  provider: FakeProvider;
}

async function run(
  scripts: Record<string, FakeBehavior[]>,
  options: {
    plan?: TierPlan;
    budget?: FakeBudget;
    breaker?: CircuitBreaker;
    signal?: AbortSignal;
    provider?: FakeProvider;
    /** Called after this many milliseconds of fake time. */
    at?: { ms: number; action: () => void };
  } = {},
): Promise<RunResult> {
  const plan = options.plan ?? fastPlan();
  const provider = options.provider ?? new FakeProvider(scripts);
  const budget = options.budget ?? new FakeBudget();
  const report = newRouteReport(plan.tier);
  const chunks: ExecutedChunk[] = [];
  let error: unknown = null;
  const done = (async () => {
    try {
      for await (const chunk of executeRouted({
        plan,
        messages: [{ role: "user", content: "hi" }],
        provider,
        budget,
        breaker: options.breaker ?? createCircuitBreaker({ threshold: 3, cooldownMs: 30_000 }),
        signal: options.signal ?? new AbortController().signal,
        report,
        random: () => 1,
      })) {
        chunks.push(chunk);
      }
    } catch (e) {
      error = e;
    }
  })();
  if (options.at) {
    await vi.advanceTimersByTimeAsync(options.at.ms);
    options.at.action();
  }
  // Runs timers only until the reply ends, so the clock moves no further than needed.
  let finished = false;
  void done.then(() => (finished = true));
  while (!finished) await vi.advanceTimersToNextTimerAsync();
  await done;
  return { chunks, error, report, budget, provider };
}

const text = (chunks: ExecutedChunk[]) => chunks.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("classifyError and backoff", () => {
  it.each([
    [408, "retry"],
    [409, "retry"],
    [425, "retry"],
    [429, "retry"],
    [500, "retry"],
    [502, "retry"],
    [503, "retry"],
    [504, "retry"],
    [404, "next_model"],
    [400, "stop"],
    [401, "stop"],
    [403, "stop"],
    [413, "stop"],
    [422, "stop"],
    [402, "stop"],
  ])("HTTP %i → %s", (status, action) => {
    expect(classifyError(new ProviderError("nebius", "unavailable", status))).toBe(action);
  });

  it("retries network errors, timeouts and broken streams, and stops on unknown errors", () => {
    expect(classifyError(new ProviderError("nebius", "unavailable"))).toBe("retry");
    expect(classifyError(new ProviderError("nebius", "timeout"))).toBe("retry");
    expect(classifyError(new ProviderError("nebius", "bad_response"))).toBe("retry");
    expect(classifyError(new ProviderError("nebius", "auth"))).toBe("stop");
    expect(classifyError(new Error("bug"))).toBe("stop");
  });

  it("uses full jitter with a growing cap", () => {
    expect(backoffMs(1, () => 1)).toBe(200);
    expect(backoffMs(2, () => 1)).toBe(400);
    expect(backoffMs(10, () => 1)).toBe(2_000);
    expect(backoffMs(3, () => 0)).toBe(0);
  });
});

describe("executeRouted", () => {
  it("streams the first model's reply and settles its hold with the real usage", async () => {
    const { chunks, error, report, budget, provider } = await run({ [A]: [{ chunks: [{ text: "Hel" }, { text: "lo" }] }] });
    expect(error).toBeNull();
    expect(text(chunks)).toBe("Hello");
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } });
    expect(report).toMatchObject({ model: A, fallback: false, attempts: 1, hedgeFired: false, outcome: "ok" });
    expect(provider.calls[0]!.request).toMatchObject({ model: A, maxOutputTokens: 256, thinkingBudgetTokens: 0 });
    expect(budget.settled).toEqual([
      { model: A, hold: budget.reserved[0]!.hold, outcome: { sent: true, usage: { promptTokens: 10, completionTokens: 5 } } },
    ]);
  });

  it("retries a 429 on the same model after Retry-After", async () => {
    const { chunks, report, provider, budget } = await run(
      { [A]: [{ status: 429, retryAfterMs: 1_200 }, {}] },
      { plan: fastPlan({ hedgeAfterMs: null }) },
    );
    expect(text(chunks)).toBe(`Answer from ${A}.`);
    const [first, second] = provider.callsTo(A);
    expect(second!.startedAt - first!.startedAt).toBeGreaterThanOrEqual(1_200);
    expect(report).toMatchObject({ model: A, fallback: false, attempts: 2 });
    // The failed attempt keeps its full hold (no usage); the good one settles its usage.
    expect(budget.settled.map((s) => s.outcome)).toEqual([
      { sent: true, usage: null },
      { sent: true, usage: { promptTokens: 10, completionTokens: 5 } },
    ]);
  });

  it("moves to the next model at once when Retry-After is too long", async () => {
    const { report, provider } = await run(
      { [A]: [{ status: 429, retryAfterMs: 30_000 }], [B]: [{}] },
      { plan: fastPlan({ hedgeAfterMs: null }) },
    );
    expect(provider.calls.map((c) => c.model)).toEqual([A, B]);
    expect(provider.calls[1]!.startedAt).toBeLessThan(100);
    expect(report).toMatchObject({ model: B, fallback: true });
  });

  it.each([400, 401])("does not retry or fall back on HTTP %i", async (status) => {
    const { error, provider, budget, report } = await run({ [A]: [{ status }], [B]: [{}] });
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(status);
    expect(provider.calls).toHaveLength(1);
    expect(report.outcome).toBe("error");
    budget.expectAllSettledOnce();
  });

  it("skips to the next model on 404 without retrying it", async () => {
    const { report, provider } = await run({ [A]: [{ status: 404 }], [B]: [{}] }, { plan: fastPlan({ hedgeAfterMs: null }) });
    expect(provider.calls.map((c) => c.model)).toEqual([A, B]);
    expect(report).toMatchObject({ model: B, fallback: true, modelsTried: [A, B] });
  });

  it("stops an attempt with no first token in time and falls back", async () => {
    const { chunks, report, provider, budget } = await run(
      { [A]: [{ delayMs: 20_000 }], [B]: [{ delayMs: 100 }] },
      { plan: fastPlan({ hedgeAfterMs: null }) },
    );
    expect(text(chunks)).toBe(`Answer from ${B}.`);
    expect(provider.callsTo(A)).toHaveLength(1);
    expect(provider.callsTo(A)[0]!.aborted).toBe(true);
    expect(provider.callsTo(B)[0]!.startedAt).toBe(5_000);
    expect(report).toMatchObject({ model: B, fallback: true, attempts: 2 });
    budget.expectAllSettledOnce();
    // The stopped attempt keeps its full hold.
    expect(budget.settled.find((s) => s.model === A)!.outcome).toEqual({ sent: true, usage: null });
  });

  it("counts reasoning as the first token, so a thinking model is not stopped", async () => {
    const { chunks, report, provider } = await run(
      { [A]: [{ chunks: [{ reasoning: true, delayMs: 1_000 }, { text: "Done.", delayMs: 12_000 }] }] },
      { plan: heavyPlan({ thinkingBudgetTokens: 1_024 }) },
    );
    expect(text(chunks)).toBe("Done.");
    expect(report).toMatchObject({ model: A, attempts: 1 });
    expect(provider.calls[0]!.request.thinkingBudgetTokens).toBe(1_024);
  });

  it("hedges a slow fast-tier call: the faster model wins and the loser is stopped and settled", async () => {
    const { chunks, report, provider, budget } = await run({ [A]: [{ delayMs: 4_000 }], [B]: [{ delayMs: 100 }] });
    expect(text(chunks)).toBe(`Answer from ${B}.`);
    expect(provider.callsTo(B)[0]!.startedAt).toBe(1_500);
    expect(provider.callsTo(A)[0]!.aborted).toBe(true);
    expect(report).toMatchObject({ hedgeFired: true, hedgeWon: true, model: B, fallback: true, attempts: 2 });
    budget.expectAllSettledOnce();
    const loser = budget.settled.find((s) => s.model === A)!;
    // The loser was sent, has no usage, and so keeps its full hold: never zero.
    expect(loser.outcome).toEqual({ sent: true, usage: null });
  });

  it("keeps the first model when it answers before the hedge", async () => {
    const { report, provider, budget } = await run({ [A]: [{ delayMs: 1_700 }], [B]: [{ delayMs: 1_000 }] });
    expect(report).toMatchObject({ hedgeFired: true, hedgeWon: false, model: A, fallback: false });
    expect(provider.callsTo(B)[0]!.aborted).toBe(true);
    budget.expectAllSettledOnce();
  });

  // Review round 1: a failed hedge used to erase the first model's Retry-After.
  it("keeps each model's Retry-After when both the first attempt and the hedge fail", async () => {
    const { chunks, provider, report } = await run({
      [A]: [
        { delayMs: 1_600, status: 429, retryAfterMs: 2_000 },
        { status: 429, retryAfterMs: 5_000 },
      ],
      [B]: [{ delayMs: 200, status: 503, retryAfterMs: 1_990 }, {}],
    });
    const starts = provider.calls.map((c) => [c.model, c.startedAt]);
    // A fails at 1,600 ms (wait 2,000 ms); the hedge B fails at 1,700 ms (wait 1,990 ms).
    expect(starts[0]).toEqual([A, 0]);
    expect(starts[1]).toEqual([B, 1_500]);
    // A's second try waits for its own Retry-After: not before 3,600 ms.
    expect(starts[2]![0]).toBe(A);
    expect(starts[2]![1]).toBeGreaterThanOrEqual(3_600);
    // A fails again at once; B's second try waits for B's Retry-After: not before 3,690 ms.
    expect(starts[3]![0]).toBe(B);
    expect(starts[3]![1]).toBeGreaterThanOrEqual(3_690);
    expect(text(chunks)).toBe(`Answer from ${B}.`);
    expect(report).toMatchObject({ attempts: 4, hedgeFired: true, model: B });
  });

  it("starts at most one hedge", async () => {
    const { provider, report } = await run({ [A]: [{ delayMs: 4_500 }], [B]: [{ delayMs: 4_500 }], [C]: [{}] });
    expect(provider.calls.map((c) => c.model)).toEqual([A, B]);
    expect(report.hedgeFired).toBe(true);
  });

  it("never hedges the heavy tier", async () => {
    const { provider, report } = await run({ [A]: [{ delayMs: 6_000 }], [B]: [{}] }, { plan: heavyPlan() });
    expect(provider.calls.map((c) => c.model)).toEqual([A]);
    expect(report).toMatchObject({ hedgeFired: false, model: A });
  });

  it("goes on without a hedge when the budget refuses it", async () => {
    const { report, provider, error } = await run({ [A]: [{ delayMs: 2_000 }], [B]: [{}] }, { budget: new FakeBudget(1) });
    expect(error).toBeNull();
    expect(provider.calls.map((c) => c.model)).toEqual([A]);
    expect(report).toMatchObject({ hedgeFired: true, model: A });
  });

  it("stops with budget_exhausted when the budget refuses a retry", async () => {
    const budget = new FakeBudget(1);
    const { error, provider, report } = await run({ [A]: [{ status: 503 }], [B]: [{}] }, { budget, plan: fastPlan({ hedgeAfterMs: null }) });
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect((error as BudgetExhaustedError).limit).toBe("day");
    expect(provider.calls).toHaveLength(1);
    expect(report.outcome).toBe("budget");
    budget.expectAllSettledOnce();
  });

  it("stops every attempt when the user aborts during a hedge", async () => {
    const controller = new AbortController();
    const { error, provider, budget, report } = await run(
      { [A]: [{ delayMs: 5_000 }], [B]: [{ delayMs: 5_000 }] },
      { signal: controller.signal, at: { ms: 1_600, action: () => controller.abort() } },
    );
    expect((error as ProviderError).kind).toBe("aborted");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.every((c) => c.aborted && c.ended)).toBe(true);
    expect(report.outcome).toBe("aborted");
    budget.expectAllSettledOnce();
  });

  it("never switches models after the first visible token", async () => {
    const { chunks, error, provider } = await run({
      [A]: [{ chunks: [{ text: "Partial" }, { error: new ProviderError("nebius", "unavailable"), delayMs: 10 }] }],
      [B]: [{}],
    });
    expect(text(chunks)).toBe("Partial");
    expect((error as ProviderError).kind).toBe("unavailable");
    expect(provider.calls.map((c) => c.model)).toEqual([A]);
  });

  it("retries a stream that breaks before the first token", async () => {
    const { report, provider } = await run(
      { [A]: [{ chunks: [{ error: new ProviderError("nebius", "unavailable") }] }, {}] },
      { plan: fastPlan({ hedgeAfterMs: null }) },
    );
    expect(provider.calls.map((c) => c.model)).toEqual([A, A]);
    expect(report.model).toBe(A);
  });

  it("treats an empty reply as a failure and tries the next model", async () => {
    const { chunks, report, budget } = await run({ [A]: [{ chunks: [] }], [B]: [{}] }, { plan: fastPlan({ hedgeAfterMs: null }) });
    expect(text(chunks)).toBe(`Answer from ${B}.`);
    expect(report).toMatchObject({ model: B, modelsTried: [A, B] });
    // The empty attempt had usage, so it settles its real cost.
    expect(budget.settled[0]!.outcome).toEqual({ sent: true, usage: { promptTokens: 10, completionTokens: 5 } });
  });

  it("reports an empty reply when every model is empty", async () => {
    const { error, report } = await run({ [A]: [{ chunks: [] }], [B]: [{ chunks: [] }], [C]: [{ chunks: [] }] });
    expect(error).toBeInstanceOf(EmptyReplyError);
    expect(report.outcome).toBe("empty");
  });

  it("never makes more attempts than the tier allows", async () => {
    const budget = new FakeBudget();
    const { error, provider, report } = await run(
      { [A]: [{ status: 503 }], [B]: [{ status: 503 }], [C]: [{ status: 503 }] },
      { budget, plan: fastPlan({ hedgeAfterMs: null }) },
    );
    expect((error as ProviderError).status).toBe(503);
    expect(provider.calls.map((c) => c.model)).toEqual([A, A, B, B]);
    expect(report.attempts).toBe(4);
    expect(budget.reserved).toHaveLength(4);
    budget.expectAllSettledOnce();
  });

  it("stops at the deadline across all attempts", async () => {
    const { error, provider, report, budget } = await run(
      { [A]: [{ delayMs: 10 ** 7 }], [B]: [{ delayMs: 10 ** 7 }] },
      { plan: heavyPlan({ deadlineMs: 20_000, firstTokenTimeoutMs: 15_000 }) },
    );
    expect((error as ProviderError).kind).toBe("timeout");
    // A was stopped at 15 s; B started then and was stopped by the deadline at 20 s.
    expect(provider.calls.map((c) => [c.model, c.startedAt])).toEqual([
      [A, 0],
      [B, 15_000],
    ]);
    expect(provider.calls.every((c) => c.aborted)).toBe(true);
    expect(report.outcome).toBe("timeout");
    expect(report.totalMs).toBe(20_000);
    budget.expectAllSettledOnce();
  });

  it("stops a committed stream at the deadline", async () => {
    const { chunks, error } = await run(
      { [A]: [{ chunks: [{ text: "Start" }], hang: true }] },
      { plan: fastPlan({ deadlineMs: 10_000 }) },
    );
    expect(text(chunks)).toBe("Start");
    expect((error as ProviderError).kind).toBe("timeout");
  });

  it("skips a model with an open breaker, then tries it again after the cooldown", async () => {
    const breaker = createCircuitBreaker({ threshold: 3, cooldownMs: 30_000 });
    const provider = new FakeProvider({ [A]: [{ status: 503 }, { status: 503 }, { status: 503 }, {}], [B]: [{}] });
    const plan = fastPlan({ hedgeAfterMs: null });

    // 1st reply: A fails twice (2 failures), B answers.
    expect((await run({}, { plan, breaker, provider })).report.model).toBe(B);
    // 2nd reply: A fails once more (3 in a row): the breaker opens and A's second try is skipped.
    const second = await run({}, { plan, breaker, provider });
    expect(second.report).toMatchObject({ model: B, breakerSkips: 1 });
    // 3rd reply: A is skipped at once.
    const third = await run({}, { plan, breaker, provider });
    expect(third.report).toMatchObject({ model: B, modelsTried: [B], breakerSkips: 1 });
    expect(provider.callsTo(A)).toHaveLength(3);

    // After the cooldown, A is tried again and its success closes the breaker.
    await vi.advanceTimersByTimeAsync(30_000);
    const fourth = await run({}, { plan, breaker, provider });
    expect(fourth.report).toMatchObject({ model: A, fallback: false, breakerSkips: 0 });
    expect(breaker.isOpen(A, Date.now())).toBe(false);
  });

  it("tries the chain anyway when every model's breaker is open", async () => {
    const breaker = createCircuitBreaker({ threshold: 1, cooldownMs: 30_000 });
    for (const model of [A, B, C]) breaker.recordFailure(model, Date.now());
    const { report } = await run({ [A]: [{}] }, { breaker });
    expect(report).toMatchObject({ model: A, breakerSkips: 0 });
  });
});
