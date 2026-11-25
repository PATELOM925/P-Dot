import { afterEach, describe, expect, it, vi } from "vitest";
import { startActiveTimeSession } from "@/features/analytics/active-time-session";

class SpecFaithfulLocks {
  held = false;
  readonly options: LockOptions[] = [];

  request(name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void> | void): Promise<unknown> {
    this.options.push(options);
    if (options.signal && (options.ifAvailable || options.steal)) {
      return Promise.reject(new DOMException("signal cannot be combined with ifAvailable or steal", "NotSupportedError"));
    }
    if (this.held) return Promise.resolve(callback(null));
    this.held = true;
    return Promise.resolve().then(() => callback({ name, mode: "exclusive" } as Lock)).then(
      (result) => { this.held = false; return result; },
      (error: unknown) => { this.held = false; throw error; },
    );
  }
}

function browserFixture(locks: SpecFaithfulLocks, statusEnabled = true) {
  const windowTarget = new EventTarget();
  const docTarget = new EventTarget();
  let visibilityState: DocumentVisibilityState = "visible";
  const document = Object.assign(docTarget, {
    get visibilityState() { return visibilityState; },
    set visibilityState(value: DocumentVisibilityState) { visibilityState = value; },
  }) as unknown as Document;
  const window = Object.assign(windowTarget, {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  }) as unknown as Window;
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    void init;
    if (String(url) === "/api/analytics/status") return Response.json({ available: true, enabled: statusEnabled });
    return Response.json({ ok: true }, { status: 200 });
  });
  return { window, document, locks, fetch, dispatchWindow: (name: string) => windowTarget.dispatchEvent(new Event(name)), dispatchVisibility: () => docTarget.dispatchEvent(new Event("visibilitychange")), setVisible: (visible: boolean) => { visibilityState = visible ? "visible" : "hidden"; } };
}

const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

describe("active-time tracker lock lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("sends one bounded sample after interaction and visible time across hide/show handoff, then stops on opt-out", async () => {
    vi.useFakeTimers();
    const locks = new SpecFaithfulLocks();
    const first = browserFixture(locks);
    const second = browserFixture(locks);
    const stopFirst = startActiveTimeSession(() => "chat", first);
    const stopSecond = startActiveTimeSession(() => "today", second);
    await settle();
    expect(locks.options).toEqual([{ ifAvailable: true }, { ifAvailable: true }]);

    first.dispatchWindow("pointerdown");
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    const samples = () => first.fetch.mock.calls.filter(([url]) => String(url) === "/api/analytics/active");
    expect(samples()).toHaveLength(1);
    expect(JSON.parse(String(samples()[0]?.[1]?.body))).toEqual({ seconds: 30, screen: "chat" });

    first.setVisible(false);
    first.dispatchVisibility();
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    first.setVisible(true);
    first.dispatchVisibility();
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    second.dispatchWindow("pointerdown");
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(samples()).toHaveLength(1);

    const optOut = new Event("pdot-analytics-consent");
    Object.defineProperty(optOut, "detail", { value: false });
    second.window.dispatchEvent(optOut);
    await vi.advanceTimersByTimeAsync(90_000);
    await settle();
    expect(second.fetch.mock.calls.filter(([url]) => String(url) === "/api/analytics/active")).toHaveLength(0);
    expect(samples()).toHaveLength(1);
    stopFirst();
    stopSecond();
  });

  it("does not request tracking when the account is opted out", async () => {
    const locks = new SpecFaithfulLocks();
    const browser = browserFixture(locks, false);
    const stop = startActiveTimeSession(() => "chat", browser);
    await settle();
    expect(locks.options).toEqual([]);
    stop();
  });
});
