import { describe, expect, it } from "vitest";
import { mcpCardState, mcpConnectedDate, mcpOutcomeMessage } from "@/features/connectors/mcp";
import { MCP_OUTCOMES, MCP_SERVER_IDS, MCP_SERVER_NAMES } from "@/lib/connectors";
import type { McpConnectionView } from "@/server/mcp/health";

function view(overrides: Partial<McpConnectionView> = {}): McpConnectionView {
  return {
    server: "notion",
    status: "connected",
    connectedAt: "2026-10-20T23:30:00.000Z",
    ready: ["notion_search", "notion_fetch"],
    missing: [],
    noRefresh: false,
    unreadable: false,
    ...overrides,
  };
}

describe("mcpCardState", () => {
  it("is not_set_up when the key is missing, before any other check", () => {
    expect(mcpCardState(false, view(), true)).toEqual({ kind: "not_set_up" });
    expect(mcpCardState(false, "load_failed", false)).toEqual({ kind: "not_set_up" });
  });

  it("asks an anonymous user for an account", () => {
    expect(mcpCardState(true, null, true)).toEqual({ kind: "account_required" });
    expect(mcpCardState(true, view(), true)).toEqual({ kind: "account_required" });
  });

  it("shows load_failed and not_connected", () => {
    expect(mcpCardState(true, "load_failed", false)).toEqual({ kind: "load_failed" });
    expect(mcpCardState(true, null, false)).toEqual({ kind: "not_connected" });
  });

  it("asks to connect again after a refresh failure or when the bundle does not open", () => {
    expect(mcpCardState(true, view({ status: "needs_reconnect" }), false)).toEqual({ kind: "needs_reconnect" });
    expect(mcpCardState(true, view({ unreadable: true, ready: [], missing: ["notion_search", "notion_fetch"] }), false)).toEqual({
      kind: "needs_reconnect",
    });
  });

  it("labels the ready and missing tools in plain words", () => {
    expect(mcpCardState(true, view({ ready: ["notion_search"], missing: ["notion_fetch"], noRefresh: true }), false)).toEqual({
      kind: "connected",
      connectedAt: "2026-10-20T23:30:00.000Z",
      ready: ["Search pages"],
      missing: ["Read a page"],
      noRefresh: true,
    });
    const todoist = mcpCardState(
      true,
      view({ server: "todoist", ready: ["todoist_list_tasks", "todoist_find_tasks"] }),
      false,
    );
    expect(todoist).toMatchObject({ kind: "connected", ready: ["List tasks due soon", "Search tasks"] });
    const linear = mcpCardState(true, view({ server: "linear", ready: ["linear_search_issues", "linear_get_issue"] }), false);
    expect(linear).toMatchObject({ kind: "connected", ready: ["Search issues", "Read an issue"] });
  });
});

describe("mcpConnectedDate", () => {
  it("formats in UTC so the server and the browser agree", () => {
    expect(mcpConnectedDate("2026-10-20T23:30:00.000Z")).toBe("Oct 20, 2026");
  });
});

describe("mcpOutcomeMessage", () => {
  it("names the app in every outcome", () => {
    for (const app of MCP_SERVER_IDS) {
      for (const outcome of MCP_OUTCOMES) {
        const message = mcpOutcomeMessage(outcome, app);
        expect(message, `${outcome} ${app}`).not.toBeNull();
        expect(message!.text).toContain(MCP_SERVER_NAMES[app]);
        expect(message!.text).not.toContain("—");
      }
    }
  });

  it("marks only the success outcomes as not errors", () => {
    const notErrors = MCP_OUTCOMES.filter((outcome) => !mcpOutcomeMessage(outcome, "notion")!.error);
    expect(notErrors).toEqual(["connected", "disconnected", "disconnected_unconfirmed"]);
  });

  it("returns null for an unknown outcome or app", () => {
    expect(mcpOutcomeMessage("hacked", "notion")).toBeNull();
    expect(mcpOutcomeMessage(undefined, "notion")).toBeNull();
    expect(mcpOutcomeMessage(["connected"], "notion")).toBeNull();
    expect(mcpOutcomeMessage("connected", "github")).toBeNull();
    expect(mcpOutcomeMessage("connected", undefined)).toBeNull();
    expect(mcpOutcomeMessage("connected", ["notion"])).toBeNull();
  });
});
