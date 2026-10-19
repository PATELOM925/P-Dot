"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { setModeAction } from "@/features/mode/actions";
import { MODE_LABELS } from "@/lib/mode";
import type { Mode } from "@/types/api";

const MODES: Mode[] = ["personal", "work"];

export function ModeToggle({ mode }: { mode: Mode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  function select(next: Mode) {
    if (next === mode || pending) return;
    startTransition(async () => {
      await setModeAction(next);
      // A conversation opened via /chat?c=... belongs to one mode, so drop it when switching.
      if (pathname === "/chat") router.replace("/chat");
    });
  }

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
