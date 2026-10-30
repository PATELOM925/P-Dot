import { describe, expect, it } from "vitest";
import { autoSources, googleToolItem, toggleSource, type MessageSources } from "@/features/chat/composer-sources";
import type { McpServerId } from "@/lib/connectors";
import { chatRequestSchema } from "@/lib/schemas";

const CONNECTED: McpServerId[] = ["notion", "linear"];
const NONE: MessageSources = { webSearch: false, useGoogle: false, apps: [] };

/** The request the composer sends for these sources, checked by the server schema. */
const accepted = (sources: MessageSources) =>
  chatRequestSchema.safeParse({
    action: "send",
    message: "hi",
    webSearch: sources.webSearch,
    ...(sources.research && sources.webSearch ? { research: true } : {}),
    ...(sources.useGoogle ? { useGoogle: true } : {}),
    ...(sources.apps.length > 0 ? { connectors: sources.apps } : {}),
  }).success;

describe("toggleSource (decision 0021)", () => {
  it("keeps web search, Google and apps on together", () => {
    let state = toggleSource(NONE, "web", CONNECTED);
    state = toggleSource(state, "google", CONNECTED);
    state = toggleSource(state, "app:notion", CONNECTED);
    state = toggleSource(state, "app:linear", CONNECTED);
    expect(state).toEqual({ webSearch: true, useGoogle: true, apps: ["notion", "linear"] });
  });

  it("turns one source off and keeps the rest", () => {
    const all: MessageSources = { webSearch: true, useGoogle: true, apps: ["notion", "linear"] };
    expect(toggleSource(all, "google", CONNECTED)).toEqual({ ...all, useGoogle: false });
    expect(toggleSource(all, "web", CONNECTED)).toEqual({ ...all, webSearch: false });
    expect(toggleSource(all, "app:notion", CONNECTED)).toEqual({ ...all, apps: ["linear"] });
    expect(toggleSource({ ...NONE, useGoogle: true }, "google", CONNECTED)).toEqual(NONE);
    expect(toggleSource({ ...NONE, webSearch: true }, "web", CONNECTED)).toEqual(NONE);
  });

  it("ignores an app that is not connected", () => {
    const state = { ...NONE, useGoogle: true };
    expect(toggleSource(state, "app:todoist", CONNECTED)).toBe(state);
  });

  it("every state the toggles can reach is a request the server accepts", () => {
    const keys = ["web", "research", "google", "app:notion", "app:linear"];
    const seen = new Set<string>();
    const walk = (state: MessageSources) => {
      const id = JSON.stringify(state);
      if (seen.has(id)) return;
      seen.add(id);
      expect(accepted(state)).toBe(true);
      if (state.research) expect(state.useGoogle || state.apps.length > 0).toBe(false);
      for (const key of keys) walk(toggleSource(state, key, CONNECTED));
    };
    walk(NONE);
    // Web, Google and 2 apps on or off (2 orders for both apps), plus deep research alone.
    expect(seen.size).toBe(2 * 2 * 5 + 1);
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

  it("turns every private source off when deep research turns on over a mixed pick", () => {
    const all: MessageSources = { webSearch: true, useGoogle: true, apps: ["notion", "linear"] };
    expect(toggleSource(all, "research", CONNECTED)).toEqual({ webSearch: true, useGoogle: false, apps: [], research: true });
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

  it.each([
    ["Check my email and my Notion page", ["notion"]],
    ["Compare my calendar with my Todoist tasks", ["todoist"]],
    ["Any unread email about the issues in my Linear board?", ["linear"]],
    ["Schedule a meeting about my Notion plan", ["notion"]],
  ])("turns on Google and the app for %j (decision 0021)", (message, apps) => {
    expect(auto(message)).toEqual({ ...NONE, useGoogle: true, apps });
  });

  it.each([
    ["Find my meeting notes in Notion", ["notion"]],
    ["Add a task in Todoist to email Sam", ["todoist"]],
    ["Remind me to mail the Notion export", ["notion"]],
  ])("turns on only the app for %j, with a weak Google word or a task", (message, apps) => {
    expect(auto(message)).toEqual({ ...NONE, apps });
  });

  it("never turns web search on by itself", () => {
    expect(auto("Check my email, my Notion and the latest news").webSearch).toBe(false);
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
