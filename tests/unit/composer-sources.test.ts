import { describe, expect, it } from "vitest";
import { autoSources, googleToolItem, toggleSource, type MessageSources } from "@/features/chat/composer-sources";
import type { McpServerId } from "@/lib/connectors";

const CONNECTED: McpServerId[] = ["notion", "linear"];
const NONE: MessageSources = { webSearch: false, useGoogle: false, apps: [] };

describe("toggleSource", () => {
  it("turning Google on turns web search and the apps off", () => {
    expect(toggleSource({ ...NONE, webSearch: true }, "google", CONNECTED)).toEqual({ webSearch: false, useGoogle: true, apps: [] });
    expect(toggleSource({ ...NONE, apps: ["notion", "linear"] }, "google", CONNECTED)).toEqual({ webSearch: false, useGoogle: true, apps: [] });
  });

  it("turning web search or an app on turns Google off", () => {
    const google = { ...NONE, useGoogle: true };
    expect(toggleSource(google, "web", CONNECTED)).toEqual({ webSearch: true, useGoogle: false, apps: [] });
    expect(toggleSource(google, "app:notion", CONNECTED)).toEqual({ webSearch: false, useGoogle: false, apps: ["notion"] });
  });

  it("keeps several apps together and turns web search off for an app", () => {
    const one = toggleSource({ ...NONE, webSearch: true }, "app:notion", CONNECTED);
    expect(one).toEqual({ webSearch: false, useGoogle: false, apps: ["notion"] });
    expect(toggleSource(one, "app:linear", CONNECTED).apps).toEqual(["notion", "linear"]);
  });

  it("turns one source off and keeps the rest", () => {
    expect(toggleSource({ ...NONE, useGoogle: true }, "google", CONNECTED)).toEqual(NONE);
    expect(toggleSource({ ...NONE, webSearch: true }, "web", CONNECTED)).toEqual(NONE);
    expect(toggleSource({ ...NONE, apps: ["notion", "linear"] }, "app:notion", CONNECTED)).toEqual({ ...NONE, apps: ["linear"] });
  });

  it("ignores an app that is not connected", () => {
    const state = { ...NONE, useGoogle: true };
    expect(toggleSource(state, "app:todoist", CONNECTED)).toBe(state);
  });

  it("never gives two kinds of source", () => {
    const keys = ["web", "google", "app:notion", "app:linear"];
    let state = NONE;
    for (let round = 0; round < 3; round += 1) {
      for (const key of keys) {
        state = toggleSource(state, key, CONNECTED);
        expect([state.webSearch, state.useGoogle, state.apps.length > 0].filter(Boolean).length).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("googleToolItem", () => {
  it("is hidden when Google is not set up", () => {
    expect(googleToolItem(null, false)).toBeNull();
  });

  it("can turn on only when connected", () => {
    expect(googleToolItem("connected", true)).toMatchObject({ key: "google", on: true });
    expect(googleToolItem("connected", true)!.unavailable).toBeUndefined();
  });

  it("links to Connectors when not connected", () => {
    expect(googleToolItem("not_connected", true)).toMatchObject({ on: false, unavailable: { href: "/connectors#google" } });
  });

  it("asks a trial user for an account, with no link", () => {
    const item = googleToolItem("trial", true)!;
    expect(item).toMatchObject({ on: false, description: "Create an account to use Google.", unavailable: {} });
    expect(item.unavailable!.href).toBeUndefined();
  });
});

describe("toggleSource with deep research", () => {
  it("turns web search on with deep research and turns Google and the apps off", () => {
    expect(toggleSource({ ...NONE, useGoogle: true }, "research", CONNECTED)).toEqual({ webSearch: true, useGoogle: false, apps: [], research: true });
    expect(toggleSource({ ...NONE, apps: ["notion"] }, "research", CONNECTED)).toEqual({ webSearch: true, useGoogle: false, apps: [], research: true });
  });

  it("turns deep research off with Google or an app, and swaps with plain web search", () => {
    const research: MessageSources = { webSearch: true, useGoogle: false, apps: [], research: true };
    expect(toggleSource(research, "google", CONNECTED)).toEqual({ webSearch: false, useGoogle: true, apps: [] });
    expect(toggleSource(research, "app:notion", CONNECTED)).toEqual({ webSearch: false, useGoogle: false, apps: ["notion"] });
    expect(toggleSource(research, "web", CONNECTED)).toEqual({ webSearch: true, useGoogle: false, apps: [] });
    expect(toggleSource(research, "research", CONNECTED)).toEqual(NONE);
    expect(toggleSource({ ...NONE, webSearch: true }, "research", CONNECTED).research).toBe(true);
  });
});

describe("autoSources", () => {
  const ALL: McpServerId[] = ["notion", "linear", "todoist"];
  const GOOGLE = { ...NONE, useGoogle: true };
  const auto = (message: string, picked = NONE, google: "connected" | "not_connected" | "trial" | null = "connected", apps = ALL) =>
    autoSources(message, picked, google, apps);

  it.each([
    "Check my latest emails",
    "Any new email from Sam?",
    "Read my e-mail",
    "What is in my inbox?",
    "Search Gmail for the invoice",
    "Do I have unread messages?",
    "Is there mail from the bank?",
    "Who emailed me today?",
    "What is on my calendar tomorrow?",
    "What meetings do I have this week?",
    "Show my agenda for Monday",
    "Am I free on Friday afternoon?",
    "Find free time next week",
    "What's my schedule today?",
    "What's on my schedule?",
    "Show me the schedule today",
    "Do I have any meetings tomorrow?",
    "Search my Gmail",
    "Is anything new in my inbox?",
    "Any free slot on Tuesday?",
    "Am I busy at 3pm?",
    "What's on today?",
    "List my events for this week",
    "Schedule a meeting with Sam on Monday at 10",
    "Set up a call with the design team",
    "Send an email to Bob about the launch",
  ])("turns Google on for %j", (message) => {
    expect(auto(message)).toEqual(GOOGLE);
  });

  it.each([
    ["Can u check my notion ?", ["notion"]],
    ["What is open in Linear?", ["linear"]],
    ["Show my linear issues", ["linear"]],
    ["What is due in Todoist today?", ["todoist"]],
    ["Compare my Notion notes with my Todoist tasks", ["notion", "todoist"]],
  ])("turns on the app that %j names", (message, apps) => {
    expect(auto(message)).toEqual({ ...NONE, apps });
  });

  it("prefers the named app to Google", () => {
    expect(auto("Check my email and my Notion page")).toEqual({ ...NONE, apps: ["notion"] });
  });

  it("turns on only an app the user connected", () => {
    expect(auto("Can u check my notion ?", NONE, "connected", ["linear"])).toEqual(NONE);
    expect(auto("Can u check my notion ?", NONE, "connected", [])).toEqual(NONE);
  });

  it.each([
    "What are the courses I had taken from York university",
    "Explain linear algebra in simple words",
    "Is this in linear time?",
    "I like the notion of a short work week",
    "Remind me to mail the package",
    "Schedule it for Monday",
    "Add a task to email Sam",
    "Remember that my work email is sam@example.com",
    "Give me ideas, e.g. for dinner",
    "What are current events in Toronto?",
    "Any news about the Fed meeting today?",
    "mail merge in Word",
    "Translate 'appointment'",
    "",
  ])("turns nothing on for %j", (message) => {
    expect(auto(message)).toEqual(NONE);
  });

  it("keeps a manual pick, also when the message names another source", () => {
    const web = { ...NONE, webSearch: true };
    expect(auto("Check my latest emails", web)).toBe(web);
    const linear: MessageSources = { ...NONE, apps: ["linear"] };
    expect(auto("Can u check my notion ?", linear)).toBe(linear);
    expect(auto("Can u check my notion ?", GOOGLE)).toBe(GOOGLE);
  });

  it.each(["not_connected", "trial", null] as const)("does not turn Google on when Google is %s", (google) => {
    expect(auto("Check my latest emails", NONE, google)).toEqual(NONE);
    expect(auto("Can u check my notion ?", NONE, google)).toEqual({ ...NONE, apps: ["notion"] });
  });
});
