import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Overview } from "@/features/today/Overview";
import { RecentChats, UpNext } from "@/features/today/TodayLists";
import type { ActionProposalDTO, ConversationSummary, MemoryDTO, ReminderDTO, TaskDTO } from "@/types/api";

const task = (id: string, done: boolean): TaskDTO => ({ id, mode: "personal", title: `Task ${id}`, done, createdAt: "2026-10-30T09:00:00Z" });

const reminder = (id: string, dueAt: string, status: ReminderDTO["status"] = "scheduled"): ReminderDTO => ({
  id,
  mode: "personal",
  title: `Reminder ${id}`,
  dueAt,
  status,
  proposalId: null,
  createdAt: "2026-10-30T09:00:00Z",
  updatedAt: "2026-10-30T09:00:00Z",
});

const proposal = (status: ActionProposalDTO["status"]): ActionProposalDTO => ({
  id: `p-${status}`,
  conversationId: null,
  payload: { kind: "create_task", mode: "personal", title: "x" },
  summary: "Add task: x",
  status,
  result: null,
  createdAt: "2026-10-30T09:00:00Z",
  decidedAt: null,
  verified: null,
} as unknown as ActionProposalDTO);

const memory = (status: MemoryDTO["status"]): MemoryDTO =>
  ({ id: `m-${status}`, mode: "personal", status, text: "likes tea" }) as unknown as MemoryDTO;

const conversation: ConversationSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Weekend plan",
  mode: "personal",
  updatedAt: "2026-10-29T10:00:00Z",
};

function render(overrides: Partial<Parameters<typeof Overview>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(Overview, {
      mode: "personal",
      tasks: [],
      reminders: [],
      memories: [],
      proposals: [],
      ...overrides,
    }),
  );
}

describe("Today overview", () => {
  it("counts only what is still open, scheduled, proposed or active", () => {
    const html = render({
      tasks: [task("1", false), task("2", true), task("3", false)],
      reminders: [reminder("a", "2026-11-01T10:00:00Z"), reminder("b", "2026-11-02T10:00:00Z", "done")],
      proposals: [proposal("proposed"), proposal("executed"), proposal("rejected")],
      memories: [memory("active"), memory("proposed")],
    });
    expect(html).toMatch(/tile-value">2<\/span><span class="tile-label">Open tasks/);
    expect(html).toMatch(/tile-value">1<\/span><span class="tile-label">Reminders ahead/);
    expect(html).toMatch(/tile-value">1<\/span><span class="tile-label">Waiting for you/);
    expect(html).toMatch(/tile-value">1<\/span><span class="tile-label">Remembered/);
  });

  it("lists the three soonest scheduled reminders first under Up next", () => {
    const html = renderToStaticMarkup(
      createElement(UpNext, {
        reminders: [
          reminder("d", "2026-11-04T10:00:00Z"),
          reminder("b", "2026-11-02T10:00:00Z"),
          reminder("a", "2026-11-01T10:00:00Z"),
          reminder("c", "2026-11-03T10:00:00Z"),
          reminder("e", "2026-10-31T10:00:00Z", "done"),
        ],
      }),
    );
    const order = ["Reminder a", "Reminder b", "Reminder c"].map((title) => html.indexOf(title));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(html).not.toContain("Reminder d");
    expect(html).not.toContain("Reminder e");
  });

  it("links the quick ask to chat as a prefilled draft, and recent chats to their conversation", () => {
    const html = render();
    expect(html).toContain('action="/chat"');
    expect(html).toContain('name="ask"');
    expect(html).toContain("/chat?ask=Plan%20a%20simple%20dinner%20for%20tonight");
    const chats = renderToStaticMarkup(createElement(RecentChats, { conversations: [conversation] }));
    expect(chats).toContain("/chat?c=11111111-1111-4111-8111-111111111111");
    expect(chats).toContain("Weekend plan");
  });

  it("changes its wording and ideas with the mode", () => {
    expect(render({ mode: "work" })).toContain("What should we move forward?");
    expect(render({ mode: "work" })).toContain("status update");
    expect(render({ mode: "personal" })).toContain("What can I take off your plate?");
  });
});
