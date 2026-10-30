import { describe, expect, it } from "vitest";
import { routeRequest } from "@/server/assistant/router";
import { detectToolIntent } from "@/server/assistant/tool-intent";
import { routeSummary } from "@/lib/routing";

describe("detectToolIntent", () => {
  it.each([
    ["Remind me to call mom at 6", "task_request"],
    ["Set a reminder for the dentist on Friday", "task_request"],
    ["Can you schedule a call with Ravi tomorrow?", "task_request"],
    ["Add buying milk to my to-do list", "task_request"],
    ["add a task: renew passport", "task_request"],
    ["put this on my todo", "task_request"],
    ["kal subah 9 baje yaad dila dena", "task_request"],
    ["mujhe dawai lene ka reminder set karo", "task_request"],
    ["Remember that I am vegetarian", "memory_request"],
    ["remember my wife's birthday is 3 March", "memory_request"],
    ["Please save this: my gate code is 4512", "memory_request"],
    ["keep in mind I hate early meetings", "memory_request"],
    ["don't forget that I work from home on Mondays", "memory_request"],
    ["yaad rakhna ki main chai peeta hoon", "memory_request"],
    ["What did I write in my notes about the trip?", "own_data"],
    ["Search my documents for the lease end date", "own_data"],
    ["what's in the file I uploaded?", "own_data"],
    ["What do you know about me?", "own_data"],
    ["do you remember what I like for breakfast", "own_data"],
    ["mere notes me Goa ka plan dekho", "own_data"],
  ] as const)("finds %j as %s", (message, intent) => {
    expect(detectToolIntent(message)).toBe(intent);
  });

  it.each([
    "hi",
    "thanks!",
    "ok cool",
    "How are you?",
    "Tell me a joke",
    "What is the capital of France?",
    "I remember when we used to play cricket",
    "kya haal hai bhai",
    "Write a short poem about rain",
    "Explain how photosynthesis works",
    "What time is it in Tokyo?",
  ])("finds no intent in %j", (message) => {
    expect(detectToolIntent(message)).toBeNull();
  });
});

describe("routeRequest with a tool intent", () => {
  const base = { historyChars: 0, webSearch: false };

  it("keeps a plain message on the fast tier", () => {
    expect(routeRequest({ ...base, message: "thanks!", toolIntent: null })).toEqual({ tier: "fast", reason: "everyday" });
  });

  it("puts a tool turn on the standard tier and names why tools are on", () => {
    const route = routeRequest({ ...base, message: "Remind me to call mom", toolIntent: "task_request" });
    expect(route).toEqual({ tier: "standard", reason: "task_request" });
    expect(routeSummary({ model: "nvidia/nemotron-3-super-120b-a12b", ...route, fallback: false })).toBe(
      "Nemotron 3 Super · task or reminder request, tools on",
    );
  });

  it("keeps Think harder on the heavy tier", () => {
    expect(routeRequest({ ...base, message: "remind me", effort: "deep", toolIntent: "task_request" })).toEqual({
      tier: "heavy",
      reason: "user_deep",
    });
  });
});
