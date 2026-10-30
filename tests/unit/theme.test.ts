import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { THEME_SCRIPT, THEME_STORAGE_KEY, nextThemeChoice, parseThemeChoice, resolveTheme } from "@/lib/theme";

function runScript(stored: string | null, systemDark: boolean) {
  const listeners: (() => void)[] = [];
  const media = { matches: systemDark, addEventListener: (_: string, listener: () => void) => listeners.push(listener) };
  const documentElement = { dataset: {} as Record<string, string> };
  const store = new Map<string, string>(stored === null ? [] : [[THEME_STORAGE_KEY, stored]]);
  runInNewContext(THEME_SCRIPT, {
    window: { matchMedia: () => media },
    localStorage: { getItem: (key: string) => store.get(key) ?? null },
    document: { documentElement },
  });
  return { theme: () => documentElement.dataset.theme, media, listeners };
}

describe("theme choice", () => {
  it("cycles System, Light, Dark", () => {
    expect(nextThemeChoice("system")).toBe("light");
    expect(nextThemeChoice("light")).toBe("dark");
    expect(nextThemeChoice("dark")).toBe("system");
  });

  it("reads an unknown or missing value as System", () => {
    expect(parseThemeChoice(null)).toBe("system");
    expect(parseThemeChoice("blue")).toBe("system");
    expect(parseThemeChoice("dark")).toBe("dark");
  });

  it("follows the device only for System", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("the theme script before the first paint", () => {
  it.each([
    [null, true, "dark"],
    [null, false, "light"],
    ["light", true, "light"],
    ["dark", false, "dark"],
  ] as const)("stored %j with a dark device %j gives %j", (stored, systemDark, theme) => {
    expect(runScript(stored, systemDark).theme()).toBe(theme);
  });

  it("follows a change of the device setting", () => {
    const run = runScript(null, false);
    run.media.matches = true;
    run.listeners.forEach((listener) => listener());
    expect(run.theme()).toBe("dark");
  });

  it("is in the root layout, and the dark palette keys on data-theme, not the media query", () => {
    expect(readFileSync("src/app/layout.tsx", "utf8")).toContain("THEME_SCRIPT");
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toContain(':root[data-theme="dark"] {');
    expect(css).not.toContain("@media (prefers-color-scheme");
  });
});
