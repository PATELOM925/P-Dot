"use client";

import { useModeSwitch } from "@/features/mode/useModeSwitch";
import { MODE_LABELS } from "@/lib/mode";
import type { Mode } from "@/types/api";

const MODES: Mode[] = ["personal", "work"];

export function ModeToggle({ mode }: { mode: Mode }) {
  const { select, pending } = useModeSwitch(mode);

  return (
    <div role="group" aria-label="Workspace mode" className="mode-toggle">
      {MODES.map((value) => (
        <button
          key={value}
          type="button"
          className="mode-option"
          aria-pressed={mode === value}
          data-mode={value}
          disabled={pending}
          onClick={() => select(value)}
        >
          {MODE_LABELS[value]}
        </button>
      ))}
    </div>
  );
}
