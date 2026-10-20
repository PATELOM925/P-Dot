import { describe, expect, it } from "vitest";
import { planAutoTurns } from "@/features/actions/useAutoApprovals";
import {
  ACTION_EFFECTS,
  AUTO_LIMIT_REASON,
  MAX_AUTO_ACTIONS_PER_REPLY,
  alwaysAskReason,
  mayRunOnItsOwn,
  parseApprovalMode,
  planAutoRun,
} from "@/lib/approval-policy";
import type { ActionPayload, ActionProposalDTO, MessageRole } from "@/types/api";

const at = (second: number) => `2026-10-19T10:00:${String(second).padStart(2, "0")}.000000+00:00`;
const task: ActionPayload = { kind: "create_task", mode: "personal", title: "Pay the bill" };
const reminder: ActionPayload = { kind: "create_reminder", mode: "personal", title: "Call Sam", dueAt: "2026-10-30T17:00:00Z" };
const memory: ActionPayload = { kind: "save_memory", mode: "personal", content: "Sam is my brother" };

function proposal(id: string, payload: ActionPayload, second: number, status: ActionProposalDTO["status"] = "proposed") {
  return {
    id,
    conversationId: "c1",
    payload,
    summary: id,
    status,
    result: null,
    createdAt: at(second),
    decidedAt: null,
    verified: false,
  } satisfies ActionProposalDTO;
}

describe("approval policy", () => {
  it("never runs anything on its own in Ask first", () => {
    for (const kind of Object.keys(ACTION_EFFECTS) as ActionPayload["kind"][]) {
      expect(mayRunOnItsOwn(kind, "manual")).toBe(false);
    }
    expect(planAutoRun([proposal("a", task, 1)], "manual")).toEqual({ run: [], ask: new Map() });
  });

  it("runs adding tasks and reminders in Auto, and still asks before saving something personal", () => {
    expect(mayRunOnItsOwn("create_task", "auto")).toBe(true);
    expect(mayRunOnItsOwn("create_reminder", "auto")).toBe(true);
    expect(mayRunOnItsOwn("save_memory", "auto")).toBe(false);
    expect(alwaysAskReason("save_memory")).toBe("It saves something about you.");
    expect(alwaysAskReason("create_task")).toBeNull();
  });

  it("splits one reply's proposals and keeps to the limit, oldest first", () => {
    const list = [
      proposal("t1", task, 1),
      proposal("m1", memory, 2),
      proposal("r1", reminder, 3),
      proposal("t2", task, 4),
      proposal("t3", task, 5),
      proposal("done", task, 6, "executed"),
    ];
    const plan = planAutoRun(list, "auto");
    expect(plan.run.map((p) => p.id)).toEqual(["t1", "r1", "t2"].slice(0, MAX_AUTO_ACTIONS_PER_REPLY));
    expect(plan.ask.get("m1")).toBe("It saves something about you.");
    expect(plan.ask.get("t3")).toBe(AUTO_LIMIT_REASON);
    expect(plan.ask.has("done")).toBe(false);
  });

  it("counts what already ran for the reply", () => {
    const plan = planAutoRun([proposal("t4", task, 7)], "auto", MAX_AUTO_ACTIONS_PER_REPLY);
    expect(plan.run).toEqual([]);
    expect(plan.ask.get("t4")).toBe(AUTO_LIMIT_REASON);
  });

  it("falls back to Ask first for anything it does not know", () => {
    expect(parseApprovalMode("auto")).toBe("auto");
    expect(parseApprovalMode("manual")).toBe("manual");
    for (const value of [null, undefined, "", "AUTO", "yolo", 1]) expect(parseApprovalMode(value)).toBe("manual");
  });
});

describe("Auto mode in a conversation", () => {
  const msg = (id: string, role: MessageRole, second: number) => ({ id, role, createdAt: at(second) });
  // Turn 1 (u1) was sent in Ask first; turn 2 (u2) was sent in Auto.
  const messages = [msg("u1", "user", 0), msg("a1", "assistant", 5), msg("u2", "user", 10), msg("a2", "assistant", 15)];
  const proposals = [proposal("old", task, 2), proposal("new-task", task, 12), proposal("new-memory", memory, 13)];

  it("acts only on replies to messages sent while Auto was on", () => {
    const view = planAutoTurns(messages, proposals, new Set(["u2"]), "auto", new Map());
    expect(view.running.map((p) => p.id)).toEqual(["new-task"]);
    expect(view.asks.get("new-memory")).toBe("It saves something about you.");
    expect(view.asks.has("old")).toBe(false);
  });

  it("does nothing once the user switches back to Ask first", () => {
    const view = planAutoTurns(messages, proposals, new Set(["u2"]), "manual", new Map());
    expect(view.running).toEqual([]);
    expect(view.asks.size).toBe(0);
  });
});
