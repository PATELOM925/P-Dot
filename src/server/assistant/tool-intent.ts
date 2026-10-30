import "server-only";

// Rule-based check for when a message needs the own-data tools (decision 0013).
// Pure and cheap, like the router: no model call. A plain everyday message
// gets no tools, so it stays on the fast tier.

/** Why the own-data tools are offered. Each value is also a route reason. */
export type ToolIntent = "task_request" | "memory_request" | "own_data";

const RULES: readonly { intent: ToolIntent; pattern: RegExp }[] = [
  {
    intent: "task_request",
    pattern: new RegExp(
      [
        String.raw`\bremind(?!\s+me\s+(?:what|who|whom|whose|which|where|why|how)\b)(?:er|ers)?\b`,
        String.raw`\bschedule\b`,
        String.raw`\bto-?dos?\b`,
        String.raw`\b(?:add|create|make|set|put)\b[^.?!]{0,30}\b(?:task|tasks|to-?do|reminder|alarm)\b`,
        String.raw`\b(?:add|put)\b[^.?!]{0,40}\bto\s+(?:my|the)\b[^.?!]{0,20}\blist\b`,
        String.raw`\byaad\s+(?:dila|dilana|dilao|dila\s+dena|dila\s+dijiye)\b`,
      ].join("|"),
      "i",
    ),
  },
  {
    intent: "memory_request",
    pattern: new RegExp(
      [
        String.raw`\bremember\s+(?:that|this|my|me|i|i'm|i am)\b`,
        String.raw`^\s*remember\s*,`,
        String.raw`\b(?:save|note)\s+(?:this|that|it)\b`,
        String.raw`\bnote\s+(?:this|that|it)\s+down\b`,
        String.raw`\bwrite\s+down\s+that\b`,
        String.raw`\bwrite\s+(?:this|that|it)\s+down\b`,
        String.raw`\bsave\s+(?:a\s+)?note\b`,
        String.raw`\bkeep\s+(?:this|that|it\s+)?in\s+mind\b`,
        String.raw`\bdon'?t\s+forget\s+(?:that|my|i)\b`,
        String.raw`\byaad\s+(?:rakh|rakhna|rakho|rakhiye|rakh\s+lo)\b`,
      ].join("|"),
      "i",
    ),
  },
  {
    intent: "own_data",
    pattern: new RegExp(
      [
        String.raw`\bmy\s+(?:notes?|documents?|docs|files?|uploads?|resume|cv|pdfs?)\b`,
        String.raw`\b(?:the|my|that|this)\s+(?:document|doc|file|pdf|resume|cv|notes?)\s+(?:that\s+|which\s+)?i\s+(?:uploaded|added|saved|shared|sent)\b`,
        String.raw`\b(?:in|from)\s+(?:the|my|that)\s+(?:file|document|doc|notes?)\b`,
        String.raw`\bwhat\s+(?:do|did)\s+you\s+(?:know|remember)\s+about\s+me\b`,
        String.raw`\bdo\s+you\s+remember\b`,
        String.raw`\bwhat\s+did\s+i\s+(?:tell|say\s+to|save|share\s+with)\s+you\b`,
        String.raw`\bmere\s+(?:notes|documents|docs|files)\b`,
      ].join("|"),
      "i",
    ),
  },
];

/** The first matching intent, or null for a message that needs no own-data tool. */
export function detectToolIntent(message: string): ToolIntent | null {
  for (const rule of RULES) if (rule.pattern.test(message)) return rule.intent;
  return null;
}
