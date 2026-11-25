import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ effect: null as null | (() => void | (() => void)) }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: (effect: () => void | (() => void)) => { hooks.effect = effect; } };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/chat" }));

import { ActiveTimeTracker } from "@/features/analytics/ActiveTimeTracker";

describe("ActiveTimeTracker browser wiring", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { window?: Window }).window;
    delete (globalThis as { document?: Document }).document;
    delete (globalThis as { navigator?: Navigator }).navigator;
    hooks.effect = null;
  });

  it("uses the Window receiver for consent status and an active-time sample", async () => {
    vi.useFakeTimers();
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const setInterval = vi.fn(globalThis.setInterval.bind(globalThis));
    const window = Object.assign(windowTarget, {
      setInterval,
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      fetch(this: Window, input: RequestInfo | URL, init?: RequestInit) {
        if (this !== window) throw new TypeError("Illegal invocation");
        const url = String(input);
        calls.push({ url, init });
        if (url === "/api/analytics/status") return Promise.resolve(Response.json({ available: true, enabled: true }));
        return Promise.resolve(Response.json({ ok: true }));
      },
    }) as unknown as Window;
    const document = Object.assign(documentTarget, { visibilityState: "visible" as DocumentVisibilityState }) as unknown as Document;
    const locks = {
      request: (_name: string, _options: LockOptions, callback: (lock: Lock | null) => Promise<void> | void) =>
        Promise.resolve(callback({ name: "active-time", mode: "exclusive" } as Lock)),
    } as LockManager;
    Object.defineProperty(globalThis, "window", { configurable: true, value: window });
    Object.defineProperty(globalThis, "document", { configurable: true, value: document });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks } });

    ActiveTimeTracker();
    const cleanup = hooks.effect?.();
    expect(calls.map((call) => call.url)).toEqual(["/api/analytics/status"]);
    await vi.waitFor(() => expect(setInterval).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(calls.map((call) => call.url)).toContain("/api/analytics/active"));
    const sample = calls.find((call) => call.url === "/api/analytics/active");
    expect(JSON.parse(String(sample?.init?.body))).toEqual({ seconds: 30, screen: "chat" });
    cleanup?.();
  });
});
