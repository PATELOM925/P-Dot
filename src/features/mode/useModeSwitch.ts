"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useTransition } from "react";
import type { Mode } from "@/types/api";
import { setModeAction } from "./actions";

// The draft of the chat box while the mode changes. The chat page is keyed by
// mode, so a switch mounts a new chat, which takes the draft once. It stays in
// this tab's memory only: never in the address, in storage or on the server.
let carriedDraft: string | null = null;

/** The draft that a mode switch carried to the new chat, or null. Does not clear it. */
export function peekCarriedDraft(): string | null {
  return carriedDraft;
}

/** Called once by the new chat after it took the draft. */
export function clearCarriedDraft(): void {
  carriedDraft = null;
}

/**
 * Personal or Work, the same for the header switch and the chat "+" menu. It
 * sets the mode cookie. On /chat it opens a new chat, because a conversation
 * keeps its mode. `draft` moves to the new chat.
 */
export function useModeSwitch(mode: Mode) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const select = useCallback(
    (next: Mode, draft?: string) => {
      if (next === mode || pending) return;
      carriedDraft = draft?.trim() ? draft : null;
      startTransition(async () => {
        try {
          await setModeAction(next);
        } catch (error) {
          carriedDraft = null;
          throw error;
        }
        // A conversation opened via /chat?c=... belongs to one mode, so drop it when switching.
        if (pathname === "/chat") router.replace("/chat");
      });
    },
    [mode, pending, pathname, router],
  );

  return { select, pending };
}
