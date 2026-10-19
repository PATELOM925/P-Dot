import { describe, expect, it } from "vitest";
import { placeBySource, placeByTime } from "@/features/chat/placement";
import { mergeSuggestions } from "@/features/memory/useMemorySuggestions";
import type { MemoryDTO, MessageRole } from "@/types/api";

const at = (minute: number) => `2026-10-19T10:${String(minute).padStart(2, "0")}:00.000000+00:00`;
const msg = (id: string, role: MessageRole, minute: number, pending = false) => ({
  id,
  role,
  createdAt: at(minute),
  pending,
});
const item = (id: string, minute: number) => ({ id, createdAt: at(minute) });
const ids = (list: { id: string }[] | undefined) => (list ?? []).map((x) => x.id);

// Turn 1: u1 at :00, reply a1 at :02. Turn 2: u2 at :10, reply a2 at :12.
const conversation = [msg("u1", "user", 0), msg("a1", "assistant", 2), msg("u2", "user", 10), msg("a2", "assistant", 12)];

describe("placing proposals by the turn they were made in", () => {
  it("puts a proposal under the reply of its turn, whether it was saved before or after the reply", () => {
    const placed = placeByTime(conversation, [item("during", 1), item("after", 5), item("second", 11)]);
    expect(ids(placed.byMessage.get("a1"))).toEqual(["during", "after"]);
    expect(ids(placed.byMessage.get("a2"))).toEqual(["second"]);
    expect(placed.rest).toEqual([]);
  });

  it("uses the user message while the turn has no saved reply", () => {
    const waitingForReply = [msg("u1", "user", 0), msg("a1", "assistant", 2), msg("u2", "user", 10)];
    expect(ids(placeByTime(waitingForReply, [item("p", 11)]).byMessage.get("u2"))).toEqual(["p"]);
  });

  it("ignores an unsaved message, which has only the browser's clock", () => {
    const sending = [msg("u1", "user", 0), msg("a1", "assistant", 2), msg("pending-1", "user", 3, true)];
    expect(ids(placeByTime(sending, [item("p", 5)]).byMessage.get("a1"))).toEqual(["p"]);
  });

  it("uses the first reply when a turn has more than one", () => {
    const twoReplies = [msg("u1", "user", 0), msg("a1", "assistant", 2), msg("a1b", "assistant", 3)];
    expect(ids(placeByTime(twoReplies, [item("p", 4)]).byMessage.get("a1"))).toEqual(["p"]);
  });

  it("keeps items with no turn, or no usable time, for the end", () => {
    const placed = placeByTime(conversation, [{ id: "early", createdAt: "2026-10-18T09:00:00Z" }, { id: "bad", createdAt: "soon" }]);
    expect(ids(placed.rest)).toEqual(["early", "bad"]);
    expect(placeByTime([], [item("p", 1)]).rest).toHaveLength(1);
  });
});

describe("placing suggestions by the message they came from", () => {
  const suggestion = (id: string, sourceMessageId: string | null) => ({ id, sourceMessageId });

  it("puts a suggestion from a reply under that reply", () => {
    expect(ids(placeBySource(conversation, [suggestion("m", "a2")]).get("a2"))).toEqual(["m"]);
  });

  it("puts a suggestion from a user message under that turn's reply, or the message while there is none", () => {
    expect(ids(placeBySource(conversation, [suggestion("m", "u1")]).get("a1"))).toEqual(["m"]);
    const noReply = [msg("u1", "user", 0)];
    expect(ids(placeBySource(noReply, [suggestion("m", "u1")]).get("u1"))).toEqual(["m"]);
  });

  it("leaves out suggestions from messages that are not loaded", () => {
    const placed = placeBySource(conversation, [suggestion("other", "x-from-another-chat"), suggestion("none", null)]);
    expect(placed.size).toBe(0);
  });
});

describe("memory suggestions decided in the chat", () => {
  const memory = (id: string, content = id): MemoryDTO => ({
    id,
    mode: "personal",
    content,
    status: "proposed",
    source: "assistant",
    sourceMessageId: "a1",
    createdAt: at(1),
    updatedAt: at(1),
  });

  it("shows waiting suggestions in order", () => {
    expect(mergeSuggestions([memory("m1"), memory("m2")], new Map()).map((s) => [s.memory.id, s.outcome])).toEqual([
      ["m1", "waiting"],
      ["m2", "waiting"],
    ]);
  });

  it("keeps a decided suggestion in its place, with the saved text", () => {
    const kept = { ...memory("m1", "Sam is my brother"), status: "active" as const };
    const merged = mergeSuggestions([memory("m1"), memory("m2")], new Map([["m1", { memory: kept, outcome: "kept" as const }]]));
    expect(merged.map((s) => [s.memory.id, s.outcome, s.memory.content])).toEqual([
      ["m1", "kept", "Sam is my brother"],
      ["m2", "waiting", "m2"],
    ]);
    expect(merged[0]!.sourceMessageId).toBe("a1");
  });

  it("still shows the outcome after a reload no longer returns it", () => {
    const decided = new Map([["gone", { memory: memory("gone"), outcome: "dropped" as const }]]);
    expect(mergeSuggestions([memory("m2")], decided).map((s) => [s.memory.id, s.outcome])).toEqual([
      ["m2", "waiting"],
      ["gone", "dropped"],
    ]);
  });
});
