"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useTransition } from "react";
import type { Mode } from "@/types/api";
import { setModeAction } from "./actions";
import { beginChatModeSwitch, endChatModeSwitch } from "./switch-state";

/**
 * Personal or Work, the same for the header switch and the chat "+" menu. It
 * sets the mode cookie. On /chat it opens a new chat with no conversation,
 * because a conversation keeps its mode. `draft` moves to the new chat.
 */
export function useModeSwitch(mode: Mode) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const select = useCallback(
    (next: Mode, draft?: string) => {
      if (next === mode || pending) return;
      const onChat = pathname === "/chat";
      if (onChat) beginChatModeSwitch(next, draft);
      startTransition(async () => {
        try {
          await setModeAction(next);
        } catch (error) {
          endChatModeSwitch();
          throw error;
        }
        // The new chat starts with no conversation; this also drops ?c= from the address.
        if (onChat) router.replace("/chat");
      });
    },
    [mode, pending, pathname, router],
  );

  return { select, pending };
}
