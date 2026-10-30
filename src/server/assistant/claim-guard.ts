import "server-only";
import type { ToolChoice } from "@/server/providers/model";
import { googleWords } from "@/lib/google-words";
import { MCP_SERVERS } from "@/server/mcp/catalog";
import type { ToolIntent } from "@/lib/tool-intent";

// A reply must never say that P-Dot proposed, added, saved or set something
// when no tool did it in this turn. Earlier replies in the history show only
// their text, so a model can copy "I've proposed a task" from them without a
// tool call. The server checks the saved reply against what the tools did.

const ACTION =
  String.raw`(?:proposed|added|created|saved|set(?:\s+up)?|scheduled|noted(?:\s+down)?|stored|remembered)`;
const THING = String.raw`(?:tasks?|reminders?|memory|memories|to-?dos?|to-?do\s+list|alarm|preference|card)`;

/** Claims that are false in any turn without a proposal. */
const CLAIMS: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:I|I've|I\s+have|I'll|I\s+will)\s+(?:also\s+|just\s+)?${ACTION}\b[^.!?\n]{0,80}\b${THING}\b`, "i"),
  /\b(?:approve|keep|confirm)\s+(?:it|this|them)\s+below\b/i,
  /\bcard\s+(?:below|is\s+waiting|now\s+asks)\b/i,
  /\bI(?:'ll|\s+will)\s+(?:remember|keep\s+(?:that|this|it)\s+in\s+mind)\b/i,
  /\b(?:saved|added)\s+(?:it\s+|that\s+|this\s+)?to\s+(?:your\s+)?(?:memory|memories|tasks|to-?do|reminders)\b/i,
];

/** "Reminder set for 6pm": a claim only when the user asked for an action, not in a how-to answer. */
const ACTION_ASKED_CLAIM = new RegExp(String.raw`\b${THING}\s+(?:is\s+|has\s+been\s+|was\s+)?(?:now\s+)?${ACTION}\b`, "i");

export const NO_CARD_LINE = "No card was made for this request, so nothing was added or saved. Send the request again to get a card.";

/** True when the text says that P-Dot proposed, added, saved or set something. */
export function claimsAction(text: string, actionAsked: boolean): boolean {
  return CLAIMS.some((claim) => claim.test(text)) || (actionAsked && ACTION_ASKED_CLAIM.test(text));
}

/**
 * Removes each sentence that claims an action and adds one honest line.
 * The text stays as it is when no sentence claims an action. Fenced blocks
 * (code and rich cards) stay whole, so their JSON is never cut.
 */
export function removeFalseClaims(text: string, actionAsked: boolean): { text: string; removed: boolean } {
  let removed = false;
  const kept = text
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part) =>
      part.startsWith("```")
        ? part
        : part.replace(/[^.!?\n]+[.!?]*/g, (sentence) => {
            if (!claimsAction(sentence, actionAsked)) return sentence;
            removed = true;
            return "";
          }),
    )
    .join("");
  if (!removed) return { text, removed };
  const tidy = kept
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: tidy ? `${tidy}\n\n${NO_CARD_LINE}` : NO_CARD_LINE, removed };
}

/** The search or list tool of each app, the first tool in its catalog entry. */
const APP_FIRST_READS = Object.values(MCP_SERVERS).flatMap((server) => server.tools.slice(0, 1).map((tool) => tool.name));

/**
 * The first hop must call a tool when the message asks to remember, or to add
 * a task or a reminder: the model cannot answer "Got it" without a card. The
 * intent wins, so "Remind me to mail the package" gets a task card, not a
 * Gmail search. With an app on, the first hop reads the app. With Google on, a
 * question about email or the calendar must read first; a request to send or
 * to write is not forced. Null when the matching tool is not offered.
 */
export function forcedToolChoice(intent: ToolIntent | null, offered: readonly { name: string }[], message = ""): ToolChoice | null {
  const names = new Set(offered.map((tool) => tool.name));
  if (intent === "memory_request" && names.has("save_memory")) return { name: "save_memory" };
  if (intent === "task_request" && names.has("propose_task") && names.has("propose_reminder")) return "required";
  if (intent === "memory_request" || intent === "task_request") return null;
  // An app is on only to read it, so the first hop reads it. Earlier replies that say
  // "I can't access your Notion" must not decide this turn.
  const appReads = APP_FIRST_READS.filter((name) => names.has(name));
  if (appReads.length === 1) return { name: appReads[0]! };
  if (appReads.length > 1) return "required";
  const words = googleWords(message);
  if (!words.read) return null;
  const mail = names.has("gmail_search") && words.mail;
  const calendar = names.has("calendar_list_events") && words.calendar;
  if (mail && calendar) return "required";
  if (mail) return { name: "gmail_search" };
  if (calendar) return { name: "calendar_list_events" };
  return null;
}
