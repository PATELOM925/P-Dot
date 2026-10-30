import { describe, expect, it, vi } from "vitest";
import { onRestoreFromBackForwardCache } from "@/lib/page-show";

function pageShow(persisted: boolean): Event {
  return Object.assign(new Event("pageshow"), { persisted });
}

describe("onRestoreFromBackForwardCache", () => {
  it("resets when Back shows the page from the back/forward cache", () => {
    const target = new EventTarget();
    const reset = vi.fn();
    onRestoreFromBackForwardCache(target, reset);
    target.dispatchEvent(pageShow(true));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("does not reset on a normal page load", () => {
    const target = new EventTarget();
    const reset = vi.fn();
    onRestoreFromBackForwardCache(target, reset);
    target.dispatchEvent(pageShow(false));
    expect(reset).not.toHaveBeenCalled();
  });

  it("stops listening after cleanup", () => {
    const target = new EventTarget();
    const reset = vi.fn();
    const cleanup = onRestoreFromBackForwardCache(target, reset);
    cleanup();
    target.dispatchEvent(pageShow(true));
    expect(reset).not.toHaveBeenCalled();
  });
});

describe("auth buttons that navigate away", () => {
  it.each([
    ["src/features/auth/AuthForm.tsx", "usePageShowKey"],
    ["src/features/auth/GoogleSignInButton.tsx", "usePageShowKey"],
    ["src/features/auth/TryWithoutAccount.tsx", "useResetOnPageShow"],
  ])("%s resets its pending state after Back", async (file, hook) => {
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(file, "utf8")).toContain(hook);
  });
});
