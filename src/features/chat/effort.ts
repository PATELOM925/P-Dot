import type { Effort } from "@/types/api";

/**
 * "Think harder" applies to one message. When the server accepts a message
 * sent with `deep`, the switch goes back to "auto", but only if the user has
 * not touched the switch since that message was sent. `version` counts the
 * user's clicks on the switch.
 */
export function effortAfterAccept(
  sent: { effort: Effort; version: number },
  current: { effort: Effort; version: number },
): Effort {
  if (sent.effort !== "deep") return current.effort;
  if (current.version !== sent.version) return current.effort;
  return "auto";
}
