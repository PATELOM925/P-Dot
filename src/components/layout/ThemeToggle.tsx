"use client";

import { useEffect, useState } from "react";
import {
  THEME_LABELS,
  THEME_STORAGE_KEY,
  nextThemeChoice,
  parseThemeChoice,
  resolveTheme,
  type ThemeChoice,
} from "@/lib/theme";

function applyTheme(choice: ThemeChoice) {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = resolveTheme(choice, systemDark);
}

function ThemeIcon({ choice }: { choice: ThemeChoice }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, "aria-hidden": true } as const;
  if (choice === "light") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (choice === "dark") {
    return (
      <svg {...common}>
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

/**
 * Cycles the theme: System, Light, Dark. The choice is kept in this browser.
 * `variant="row"` is the phone More sheet; the default is the header icon button.
 */
export function ThemeToggle({ variant = "icon" }: { variant?: "icon" | "row" }) {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    // The stored choice is known only in the browser; the server renders "system".
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one read after mount
    setChoice(parseThemeChoice(window.localStorage.getItem(THEME_STORAGE_KEY)));
  }, []);

  function cycle() {
    const next = nextThemeChoice(choice);
    setChoice(next);
    try {
      if (next === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage is off: the theme still changes for this page.
    }
    applyTheme(next);
  }

  const label = `Theme: ${THEME_LABELS[choice]}. Change to ${THEME_LABELS[nextThemeChoice(choice)]}.`;
  if (variant === "row") {
    return (
      <button type="button" className="sheet-row sheet-row-button theme-row" aria-label={label} onClick={cycle}>
        <ThemeIcon choice={choice} />
        <span>Theme: {THEME_LABELS[choice]}</span>
      </button>
    );
  }
  return (
    <button type="button" className="button button-small theme-toggle" aria-label={label} title={label} onClick={cycle}>
      <ThemeIcon choice={choice} />
    </button>
  );
}
