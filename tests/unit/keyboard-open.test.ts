import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isKeyboardOpen } from "@/components/layout/useKeyboardOpen";

describe("isKeyboardOpen", () => {
  it("is open when a keyboard covers part of a phone screen", () => {
    expect(isKeyboardOpen(852, 852 - 336, 1)).toBe(true);
  });

  it("is closed with no keyboard, or with a browser bar that hides on scroll", () => {
    expect(isKeyboardOpen(852, 852, 1)).toBe(false);
    expect(isKeyboardOpen(852, 852 - 56, 1)).toBe(false);
  });

  it("is closed while the user zooms in", () => {
    expect(isKeyboardOpen(852, 852 / 2, 2)).toBe(false);
  });

  it("the tabs never hide on focus", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).not.toMatch(/:focus-within[^{]*bottom-nav|bottom-nav[^{]*:focus-within/);
  });
});
