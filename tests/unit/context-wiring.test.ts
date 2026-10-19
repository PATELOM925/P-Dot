import { describe, expect, it } from "vitest";
import { PROMPT_VERSION } from "@/server/assistant/prompt";
import { prepareChatTurn, streamChatTurn, type AssistantDeps } from "@/server/assistant/service";
import type { ContextRecordRepository, NewContextRecord } from "@/server/db/context-records";
import type { ChatRequest } from "@/types/api";
import { fakeDeps } from "../support/fakes";
import { collect } from "../support/streams";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function recordingRepo(fail = false) {
  const records: { userId: string; record: NewContextRecord }[] = [];
  const repo: ContextRecordRepository = {
    async insertContextRecord(userId, record) {
      if (fail) throw new Error("db down");
      records.push({ userId, record });
    },
    async getContextRecord() {
      return null;
    },
  };
  return { repo, records };
}

async function run(deps: AssistantDeps, request: ChatRequest) {
  const prepared = await prepareChatTurn(deps, { userId: ALICE, requestId: "req-1", request });
  if (!prepared.ok) throw new Error("not prepared");
  return collect(streamChatTurn(deps, prepared.turn, new AbortController().signal));
}

describe("context records for saved replies", () => {
  it("stores one record for the saved reply, without any text", async () => {
    const { deps, waited } = fakeDeps();
    const { repo, records } = recordingRepo();
    deps.contextRecords = repo;
    const events = await run(deps, { action: "send", message: "Plan my week", webSearch: false });
    await Promise.all(waited);

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(records).toHaveLength(1);
    const { userId, record } = records[0]!;
    expect(userId).toBe(ALICE);
    expect(record.messageId).toBe(done && done.type === "done" ? done.message.id : "");
    expect(record.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(record.historyMessageCount).toBe(1);
    expect(record.historyChars).toBe("Plan my week".length);
    expect(record.memoryIds).toEqual([]);
    expect(record.documentChunkIds).toEqual([]);
    expect(record.webSourceCount).toBe(0);
    expect(record.promptVersion).toBe(PROMPT_VERSION);
    expect(record.inputTokens).toBe(10);
    expect(record.outputTokens).toBe(2);
    expect(JSON.stringify(record)).not.toContain("Plan my week");
  });

  it("keeps the reply when the record cannot be saved, and logs a warning", async () => {
    const { deps, waited, logs } = fakeDeps();
    deps.contextRecords = recordingRepo(true).repo;
    const events = await run(deps, { action: "send", message: "Hi", webSearch: false });
    await Promise.all(waited);
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(logs.some((l) => l.event === "context_record_failed")).toBe(true);
  });

  it("stores no token counts when the provider sends invalid usage", async () => {
    const { deps, waited } = fakeDeps({
      reply: () =>
        (async function* () {
          yield { type: "text" as const, text: "Hello" };
          yield { type: "finish" as const, finishReason: "stop", usage: { promptTokens: -1, completionTokens: 2 } };
        })(),
    });
    const { repo, records } = recordingRepo();
    deps.contextRecords = repo;
    await run(deps, { action: "send", message: "Hi", webSearch: false });
    await Promise.all(waited);
    expect(records[0]?.record.inputTokens).toBeNull();
    expect(records[0]?.record.outputTokens).toBeNull();
  });

  it("writes nothing when no repository is wired", async () => {
    const { deps, waited } = fakeDeps();
    const events = await run(deps, { action: "send", message: "Hi", webSearch: false });
    await Promise.all(waited);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });
});
