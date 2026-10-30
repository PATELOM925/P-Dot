// Model routing names shared by the browser and the server. No secrets here.
// See docs/decisions/0007-model-routing.md.

/** Model tiers, from cheapest to most expensive. `vision` is for image input. */
export const MODEL_TIERS = ["fast", "standard", "heavy", "vision"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** How hard the assistant should think. `deep` always uses the heavy tier. */
export const EFFORTS = ["auto", "deep"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Why the router chose a tier. Stored with each reply; contains no user content. */
export const ROUTE_REASONS = [
  "everyday",
  "long_message",
  "long_context",
  "web_search",
  "planning",
  "analysis",
  "math",
  "code",
  "multi_step",
  "user_deep",
  "image",
  "requested",
  "task_request",
  "memory_request",
  "own_data",
  "connector_read",
] as const;
export type RouteReason = (typeof ROUTE_REASONS)[number];

/** Which model answered a reply, and why. */
export interface MessageRoute {
  model: string;
  tier: ModelTier;
  reason: RouteReason;
  /** True when a model other than the tier's first choice answered. */
  fallback: boolean;
}

const REASON_LABELS: Record<RouteReason, string> = {
  everyday: "everyday request",
  long_message: "long message",
  long_context: "long conversation",
  web_search: "web search results",
  planning: "planning request",
  analysis: "analysis or comparison",
  math: "math request",
  code: "code request",
  multi_step: "multi-step request",
  user_deep: "you asked to think harder",
  image: "image input",
  requested: "requested by the assistant",
  task_request: "task or reminder request, tools on",
  memory_request: "request to remember, tools on",
  own_data: "about your notes or memories, tools on",
  connector_read: "read a connected app",
};

const MODEL_NAMES: Record<string, string> = {
  "nvidia/Nemotron-3_5-Lightning": "Nemotron 3.5 Lightning",
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": "Nemotron 3 Nano",
  "nvidia/nemotron-3-super-120b-a12b": "Nemotron 3 Super",
  "nvidia/Nemotron-3-Ultra-550b-a55b": "Nemotron 3 Ultra",
  "nvidia/Nemotron-3.5-Super-VL": "Nemotron 3.5 Super VL",
};

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === "string" && (MODEL_TIERS as readonly string[]).includes(value);
}

export function isRouteReason(value: unknown): value is RouteReason {
  return typeof value === "string" && (ROUTE_REASONS as readonly string[]).includes(value);
}

export function routeReasonLabel(reason: RouteReason): string {
  return REASON_LABELS[reason];
}

/** A short name for a model ID, for example "Nemotron 3 Super". */
export function modelDisplayName(model: string): string {
  return MODEL_NAMES[model] ?? model.split("/").at(-1) ?? model;
}

/** The line shown under a reply, for example "Nemotron 3 Super · multi-step request". */
export function routeSummary(route: MessageRoute): string {
  const parts = [modelDisplayName(route.model), routeReasonLabel(route.reason)];
  if (route.fallback) parts.push("after fallback");
  return parts.join(" · ");
}
