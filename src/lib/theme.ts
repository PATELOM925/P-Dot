/** The theme the user picked. "system" follows the device setting. Saved in this browser only. */
export type ThemeChoice = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "pdot-theme";
export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];
export const THEME_LABELS: Record<ThemeChoice, string> = { system: "System", light: "Light", dark: "Dark" };

export function parseThemeChoice(value: string | null | undefined): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}

/** The next choice of the cycling button: System, Light, Dark, then System again. */
export function nextThemeChoice(choice: ThemeChoice): ThemeChoice {
  return THEME_CHOICES[(THEME_CHOICES.indexOf(choice) + 1) % THEME_CHOICES.length]!;
}

/** The palette to show. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): "light" | "dark" {
  return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}

/**
 * Runs in <head> before the first paint, so the page does not flash the wrong
 * palette. It sets `data-theme` on <html> and follows a change of the device
 * setting while the choice is "system". Keep it in step with the functions above.
 */
export const THEME_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var m=window.matchMedia("(prefers-color-scheme: dark)");var a=function(){var c=localStorage.getItem(k);var d=c==="dark"||(c!=="light"&&m.matches);document.documentElement.dataset.theme=d?"dark":"light";};a();m.addEventListener("change",a);}catch(e){}})();`;
