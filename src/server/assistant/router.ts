import "server-only";
import type { Effort, ModelTier, RouteReason } from "@/lib/routing";

// Deterministic model router. A pure function from request features to a
// tier. It makes no model call, so it adds no latency.
// See docs/decisions/0007-model-routing.md.

export interface RouteFeatures {
  /** The user message this reply answers. */
  message: string;
  /** Characters of earlier conversation sent with it (context size). */
  historyChars: number;
  webSearch: boolean;
  /** Image input (not in the chat API yet; the hook for the vision tier). */
  hasImage?: boolean;
  effort?: Effort;
  /** A caller (for example an agent loop step) that knows the tier it needs. */
  requestedTier?: ModelTier;
}

export interface RouteDecision {
  tier: ModelTier;
  reason: RouteReason;
}

/** A message at least this long goes to `standard`, or to `heavy` with one reasoning signal. */
export const LONG_MESSAGE_CHARS = 1_200;
/** Earlier conversation of at least this many characters goes to `standard`. */
export const LONG_CONTEXT_CHARS = 16_000;

type Signal = Extract<RouteReason, "planning" | "analysis" | "math" | "code" | "multi_step">;

/**
 * Patterns that show a request needs reasoning. Each signal counts once.
 * Keep them specific: everyday words ("plan dinner") must not match on their own
 * more than one signal.
 */
const SIGNALS: { signal: Signal; patterns: RegExp[] }[] = [
  {
    signal: "planning",
    patterns: [
      /\bplan (out |a |an |my |our |the |for )/i,
      /\b(itinerary|roadmap|milestones?|timeline for)\b/i,
      /\bstep[- ]by[- ]step\b/i,
      /\bbreak (it|this|that) down\b/i,
      /\b(strategy|strategies) (for|to)\b/i,
    ],
  },
  {
    signal: "analysis",
    patterns: [
      /\bcompare\b|\bcomparison\b/i,
      /\b(vs\.?|versus)\b/i,
      /\bpros and cons\b/i,
      /\btrade-?offs?\b/i,
      /\banaly[sz]e\b|\banalysis\b/i,
      /\b(evaluate|assess)\b/i,
      /\bwhich (is|one is|would be) better\b/i,
      /\bdifference between\b/i,
      /\b(explain|tell me) why\b/i,
      /\broot cause\b/i,
    ],
  },
  {
    signal: "math",
    patterns: [
      /\d\s*[*/^×÷]\s*\d/,
      /\b(solve|equation|integral|derivative|probability|theorem|proof|prove|derive)\b/i,
      /\b(calculate|compute)\b/i,
    ],
  },
  {
    signal: "code",
    patterns: [
      /```/,
      /\b(debug|refactor|stack ?trace|traceback|regex|unit tests?|compile|segfault)\b/i,
      /\b(python|javascript|typescript|golang|sql|c\+\+|kotlin|swift code|bash script)\b/i,
      /\b(function|script|sql query) (that|to|which)\b/i,
      /=>|\bdef \w+\(|\bconst \w+ =|;\s*$/m,
    ],
  },
];

/** Three or more list items, or three or more questions, read as a multi-step request. */
function hasMultiStepStructure(message: string): boolean {
  const listItems = message.split("\n").filter((line) => /^\s*(\d+[.)]|[-*•])\s+\S/.test(line)).length;
  const questions = (message.match(/\?/g) ?? []).length;
  return listItems >= 3 || questions >= 3;
}

/** The reasoning signals in a message, in table order. Exported for tests. */
export function reasoningSignals(message: string): Signal[] {
  const found: Signal[] = SIGNALS.filter(({ patterns }) => patterns.some((p) => p.test(message))).map(
    ({ signal }) => signal,
  );
  if (hasMultiStepStructure(message)) found.push("multi_step");
  return found;
}

/**
 * Chooses a tier. First match wins:
 *
 * | Rule                                          | Tier     | Reason        |
 * | --------------------------------------------- | -------- | ------------- |
 * | Caller asks for a tier                        | that one | requested     |
 * | Image input                                   | vision   | image         |
 * | User chose "Think harder"                     | heavy    | user_deep     |
 * | Two or more reasoning signals, or a list of   | heavy    | multi_step    |
 * | three or more steps or questions              |          |               |
 * | One signal in a long message                  | heavy    | the signal    |
 * | One signal                                    | standard | the signal    |
 * | Long message                                  | standard | long_message  |
 * | Long conversation                             | standard | long_context  |
 * | Web search on                                 | standard | web_search    |
 * | Anything else                                 | fast     | everyday      |
 */
export function routeRequest(features: RouteFeatures): RouteDecision {
  if (features.requestedTier) return { tier: features.requestedTier, reason: "requested" };
  if (features.hasImage) return { tier: "vision", reason: "image" };
  if (features.effort === "deep") return { tier: "heavy", reason: "user_deep" };

  const message = features.message.trim();
  const long = message.length >= LONG_MESSAGE_CHARS;
  const signals = reasoningSignals(message);
  if (signals.length >= 2 || signals.includes("multi_step")) return { tier: "heavy", reason: "multi_step" };
  if (signals.length === 1) return { tier: long ? "heavy" : "standard", reason: signals[0]! };
  if (long) return { tier: "standard", reason: "long_message" };
  if (features.historyChars >= LONG_CONTEXT_CHARS) return { tier: "standard", reason: "long_context" };
  if (features.webSearch) return { tier: "standard", reason: "web_search" };
  return { tier: "fast", reason: "everyday" };
}
