import type { Mode } from "@/types/api";

// A mode switch on /chat, until the new chat mounts. The chat page is keyed by
// mode, so the switch mounts a new chat. That chat can mount while the address
// still has the old mode's ?c=, so it must start with no conversation. The
// draft stays in this tab's memory only: never in the address, in storage or
// on the server.
let carried: { mode: Mode; draft: string | null } | null = null;

/** Records a switch to `mode` on /chat. `draft` moves to the new chat. */
export function beginChatModeSwitch(mode: Mode, draft?: string): void {
  carried = { mode, draft: draft?.trim() ? draft : null };
}

/** Forgets the switch: it failed, or the new chat took it. */
export function endChatModeSwitch(): void {
  carried = null;
}

/** The old chat sent the draft while the switch was pending, so the new chat must not show it again. */
export function dropCarriedDraft(): void {
  if (carried) carried = { ...carried, draft: null };
}

/**
 * How a chat in `mode` starts. After a switch to `mode` it has no conversation,
 * whatever ?c= the address still has, and it takes the carried draft. Does not
 * end the switch.
 */
export function chatStart(
  mode: Mode,
  initialConversationId: string | null,
  initialDraft: string,
): { conversationId: string | null; draft: string } {
  const switched = carried?.mode === mode ? carried : null;
  return {
    conversationId: switched ? null : initialConversationId,
    draft: initialDraft || (switched?.draft ?? ""),
  };
}
