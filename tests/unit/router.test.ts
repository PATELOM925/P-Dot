import { describe, expect, it } from "vitest";
import { MODEL_TIERS, ROUTE_REASONS, routeReasonLabel, routeSummary } from "@/lib/routing";
import { LONG_CONTEXT_CHARS, LONG_MESSAGE_CHARS, routeRequest, type RouteFeatures } from "@/server/assistant/router";

const base: Omit<RouteFeatures, "message"> = { historyChars: 0, webSearch: false };
const route = (message: string, extra: Partial<RouteFeatures> = {}) => routeRequest({ ...base, message, ...extra });

describe("routeRequest: everyday messages go to the fast tier", () => {
  it.each([
    "hi",
    "Thanks!",
    "What is the capital of France?",
    "Write a short email to my boss saying I will be 10 minutes late.",
    "Suggest a name for my new cat.",
    "What should I cook tonight with eggs and spinach?",
    "Translate 'good morning' to Spanish.",
    "Remind me what we talked about last time.",
    "Give me three gift ideas for my sister.",
    "How do I boil an egg?",
    "Rewrite this sentence to sound friendlier: please send the file.",
    "What time zone is Tokyo in?",
    "Summarize this in one line: the meeting moved to Friday.",
    "Is it rude to leave a party early?",
  ])("%s", (message) => {
    expect(route(message)).toEqual({ tier: "fast", reason: "everyday" });
  });
});

describe("routeRequest: one reasoning signal goes to the standard tier", () => {
  it.each([
    ["Plan a birthday party for my 8 year old.", "planning"],
    ["Make an itinerary for 3 days in Lisbon.", "planning"],
    ["Compare the iPhone and the Pixel cameras.", "analysis"],
    ["Rent vs buy in my city?", "analysis"],
    ["What are the pros and cons of remote work?", "analysis"],
    ["What is the difference between a Roth IRA and a 401k?", "analysis"],
    ["What is 17 * 23?", "math"],
    ["Solve x + 3 = 10.", "math"],
    ["Calculate the tip on a $64 bill at 18 percent.", "math"],
    ["Help me debug this error: undefined is not a function", "code"],
    ["Write a python function that reverses a list.", "code"],
    ["```\nconsole.log(1)\n```", "code"],
    ["Explain why the sky is blue.", "analysis"],
  ])("%s", (message, reason) => {
    expect(route(message)).toEqual({ tier: "standard", reason });
  });
});

describe("routeRequest: multi-step requests go to the heavy tier", () => {
  it.each([
    "Compare three job offers and plan my next 6 months step by step.",
    "Write a SQL query to find duplicates and explain why my current one is slow compared to an index.",
    "Plan a migration from MySQL to Postgres: analyze the risks and give milestones.",
    "1. Read my notes\n2. Find the open tasks\n3. Rank them by deadline",
    "Why does this fail? What changed? How do I fix it?",
    "Prove that the sum of two even numbers is even, then compare it with the odd case.",
  ])("%s", (message) => {
    expect(route(message)).toEqual({ tier: "heavy", reason: "multi_step" });
  });

  it("sends one signal in a long message to heavy", () => {
    const message = `Please analyze this report. ${"The quarter went fine overall. ".repeat(50)}`;
    expect(message.length).toBeGreaterThanOrEqual(LONG_MESSAGE_CHARS);
    expect(route(message)).toEqual({ tier: "heavy", reason: "analysis" });
  });
});

describe("routeRequest: size, search and explicit choices", () => {
  it("sends a long plain message to standard", () => {
    expect(route("Here is my story. ".repeat(80))).toEqual({ tier: "standard", reason: "long_message" });
  });

  it("sends a short message in a long conversation to standard", () => {
    expect(route("ok, and then?", { historyChars: LONG_CONTEXT_CHARS })).toEqual({
      tier: "standard",
      reason: "long_context",
    });
    expect(route("ok, and then?", { historyChars: LONG_CONTEXT_CHARS - 1 }).tier).toBe("fast");
  });

  it("sends a web search turn to standard", () => {
    expect(route("latest news on the Mars mission", { webSearch: true })).toEqual({
      tier: "standard",
      reason: "web_search",
    });
  });

  it("sends 'Think harder' to heavy, even for a short message", () => {
    expect(route("hi", { effort: "deep" })).toEqual({ tier: "heavy", reason: "user_deep" });
    expect(route("hi", { effort: "auto" }).tier).toBe("fast");
  });

  it("sends image input to vision, before any other rule", () => {
    expect(route("what is this?", { hasImage: true, effort: "deep" })).toEqual({ tier: "vision", reason: "image" });
  });

  it("lets a caller (the agent loop) ask for a tier directly", () => {
    for (const tier of MODEL_TIERS) {
      expect(route("Compare plans step by step", { requestedTier: tier })).toEqual({ tier, reason: "requested" });
    }
  });

  it("does not treat everyday words as reasoning signals", () => {
    for (const message of ["Plan dinner", "my zip code is 10001", "a class for kids", "I scheduled my dentist"]) {
      expect(route(message).tier, message).toBe("fast");
    }
  });
});

describe("route labels", () => {
  it("has a plain label for every reason", () => {
    for (const reason of ROUTE_REASONS) expect(routeReasonLabel(reason).length).toBeGreaterThan(0);
  });

  it("builds the line shown under a reply", () => {
    expect(
      routeSummary({ model: "nvidia/nemotron-3-super-120b-a12b", tier: "standard", reason: "multi_step", fallback: false }),
    ).toBe("Nemotron 3 Super · multi-step request");
    expect(
      routeSummary({ model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", tier: "fast", reason: "everyday", fallback: true }),
    ).toBe("Nemotron 3 Nano · everyday request · after fallback");
    expect(routeSummary({ model: "acme/new-model", tier: "fast", reason: "everyday", fallback: false })).toBe(
      "new-model · everyday request",
    );
  });
});
