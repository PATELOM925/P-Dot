import { describe, expect, it } from "vitest";
import { forcedToolChoice, NO_CARD_LINE, removeFalseClaims } from "@/server/assistant/claim-guard";
import { prepareChatTurn, streamChatTurn, type AssistantDeps } from "@/server/assistant/service";
import { ProviderError } from "@/server/providers/errors";
import { toolFields } from "@/server/providers/nebius/client";
import type { CompletionChunk, ModelCallRequest, ModelProvider, ToolCall } from "@/server/providers/model";
import type { ChatRequest } from "@/types/api";
import { FakeOwnData, FakeSpend, MemoryRepository, fakeDeps, testEmbedder } from "../support/fakes";
import { collect } from "../support/streams";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Step = { text?: string; calls?: ToolCall[]; fail?: ProviderError };

function scripted(steps: Step[]) {
  const requests: ModelCallRequest[] = [];
  const provider: ModelProvider = {
    name: "nebius",
    stream(request) {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      return (async function* (): AsyncGenerator<CompletionChunk> {
        if (step.fail) throw step.fail;
        if (step.text) yield { type: "text", text: step.text };
        if (step.calls) {
          yield { type: "tool_progress" };
          yield { type: "tool_calls", calls: step.calls };
        }
        yield { type: "finish", finishReason: "stop", usage: { promptTokens: 100, completionTokens: 10 } };
      })();
    },
  };
  return { provider, requests };
}

function setup(steps: Step[], repo = new MemoryRepository()) {
  const spend = new FakeSpend();
  const own = new FakeOwnData(ALICE, testEmbedder(spend), () => repo.messages.at(-1)?.createdAt ?? "2026-10-14T12:00:00.000Z");
  const { provider, requests } = scripted(steps);
  const fake = fakeDeps({ repo, spend, provider, ownData: own.services() });
  return { ...fake, own, repo, requests };
}

async function runTurn(deps: AssistantDeps, request: ChatRequest, waited: Promise<unknown>[]) {
  const prepared = await prepareChatTurn(deps, { userId: ALICE, requestId: "req-1", request });
  if (!prepared.ok) throw new Error(`refused: ${prepared.code}`);
  const events = await collect(streamChatTurn(deps, prepared.turn, new AbortController().signal));
  await Promise.all(waited);
  return { turn: prepared.turn, events };
}

const call = (name: string, args: unknown, id = "c1"): ToolCall => ({ id, name, arguments: JSON.stringify(args) });

describe("removeFalseClaims", () => {
  it("removes the claim sentences of the production reply and adds one honest line", () => {
    const out = removeFalseClaims("I've proposed a task to buy milk. Please approve it below.", true);
    expect(out).toEqual({ text: NO_CARD_LINE, removed: true });
  });

  it.each([
    "Got it! I'll remember that you prefer short answers.",
    "Done. I have saved your preference for short answers.",
    "I've set a reminder for 6pm tomorrow.",
    "I added it to your tasks.",
    "The card below asks you to approve it.",
  ])("finds a claim in %j", (text) => {
    expect(removeFalseClaims(text, false).removed).toBe(true);
  });

  it("keeps the other sentences", () => {
    const out = removeFalseClaims("Milk is on sale at No Frills. I've added a task to buy milk.\n\nAnything else?", true);
    expect(out.text).toBe(`Milk is on sale at No Frills.\n\nAnything else?\n\n${NO_CARD_LINE}`);
  });

  it("never cuts a fenced card block", () => {
    const block = '```pdot-steps\n{"title":"Plan","items":[{"title":"Reminder set for 6pm. Call mom."}]}\n```';
    const out = removeFalseClaims(`I've set a reminder for 6pm.\n\n${block}`, true);
    expect(out.text).toBe(`${block}\n\n${NO_CARD_LINE}`);
  });

  it("counts 'reminder set' as a claim only when the user asked for an action", () => {
    const howTo = "Open the Clock app and tap Alarm. The alarm is set when the switch is green.";
    expect(removeFalseClaims(howTo, false)).toEqual({ text: howTo, removed: false });
    expect(removeFalseClaims("Reminder set for 6pm.", true).removed).toBe(true);
  });

  it.each([
    "Here is a short list of cafes near Union Station.",
    "I've created a list of three options below.",
    "You can add a task from the Today page.",
    "Short answers it is.",
  ])("leaves %j alone", (text) => {
    expect(removeFalseClaims(text, true)).toEqual({ text, removed: false });
  });
});

describe("forcedToolChoice", () => {
  const tools = [{ name: "search_memories" }, { name: "propose_task" }, { name: "propose_reminder" }, { name: "save_memory" }];

  it("names save_memory for a memory request and asks for any tool for a task request", () => {
    expect(forcedToolChoice("memory_request", tools)).toEqual({ name: "save_memory" });
    expect(forcedToolChoice("task_request", tools)).toBe("required");
    expect(forcedToolChoice("own_data", tools)).toBeNull();
    expect(forcedToolChoice(null, tools)).toBeNull();
    expect(forcedToolChoice("memory_request", [{ name: "web_search" }])).toBeNull();
  });

  it("sends a named choice in the OpenAI function shape", () => {
    const tool = { name: "save_memory", description: "d", parameters: {} };
    expect(toolFields([tool], { name: "save_memory" }).tool_choice).toEqual({ type: "function", function: { name: "save_memory" } });
    expect(toolFields([tool]).tool_choice).toBe("auto");
    expect(toolFields([], "required")).toEqual({});
  });
});

describe("chat turns that ask for an action", () => {
  it("forces save_memory on the first hop, so 'remember that' makes a memory card", async () => {
    const { deps, own, requests, waited } = setup([
      { calls: [call("save_memory", { content: "Prefers short answers" })] },
      { text: "Got it. Keep it below." },
    ]);

    const { events } = await runTurn(deps, { action: "send", message: "Remember that I prefer short answers", webSearch: false }, waited);

    expect(requests[0]!.toolChoice).toEqual({ name: "save_memory" });
    expect(requests[1]!.toolChoice).toBeUndefined();
    expect(own.memories).toHaveLength(1);
    const done = events.find((event) => event.type === "done");
    expect(done && done.type === "done" && done.message.content).toBe("Got it. Keep it below.");
  });

  it("offers the tools on a later turn of a conversation and removes a claim that no tool made", async () => {
    const repo = new MemoryRepository();
    const first = setup([{ calls: [call("propose_reminder", { title: "Call mom", dueAt: "2026-10-15T18:00:00+05:30" })] }, { text: "Approve it below." }], repo);
    const { turn } = await runTurn(first.deps, { action: "send", message: "Remind me to call mom tomorrow at 6pm", webSearch: false }, first.waited);

    const second = setup([{ text: "I've proposed a task to buy milk. Please approve it below." }], repo);
    const { events } = await runTurn(
      second.deps,
      { action: "send", conversationId: turn.conversation.id, message: "add a task to buy milk", webSearch: false },
      second.waited,
    );

    expect(second.requests[0]!.tools?.map((tool) => tool.name)).toContain("propose_task");
    expect(second.requests[0]!.toolChoice).toBe("required");
    expect(second.requests[0]!.messages[0]!.content).toContain("Earlier replies do not show their tool calls.");
    const saved = repo.messages.at(-1)!;
    expect(saved.content).toBe(NO_CARD_LINE);
    const done = events.find((event) => event.type === "done");
    expect(done && done.type === "done" && done.message.content).toBe(NO_CARD_LINE);
    expect(second.logs.map((log) => log.event)).toContain("false_claim_removed");
    expect(JSON.stringify(second.logs)).not.toContain("milk");
  });

  it("keeps the claim when a proposal was made in the turn", async () => {
    const { deps, own, repo, waited } = setup([
      { calls: [call("propose_task", { title: "Buy milk" })] },
      { text: "I've proposed a task to buy milk. Please approve it below." },
    ]);

    await runTurn(deps, { action: "send", message: "add a task to buy milk", webSearch: false }, waited);

    expect(own.proposals).toHaveLength(1);
    expect(repo.messages.at(-1)!.content).toBe("I've proposed a task to buy milk. Please approve it below.");
  });

  it("runs the first hop again with 'auto' when the model refuses the forced choice", async () => {
    const { deps, own, requests, logs, waited } = setup([
      { fail: new ProviderError("nebius", "invalid_request", 400) },
      { calls: [call("save_memory", { content: "Prefers short answers" })] },
      { text: "Keep it below." },
    ]);

    await runTurn(deps, { action: "send", message: "Remember that I prefer short answers", webSearch: false }, waited);

    expect(requests.map((request) => request.toolChoice)).toEqual([{ name: "save_memory" }, undefined, undefined]);
    expect(own.memories).toHaveLength(1);
    expect(logs.map((log) => log.event)).toContain("tool_choice_refused");
  });
});
