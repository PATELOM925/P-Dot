import { describe, expect, it } from "vitest";
import { googleToolItem, toggleSource, type MessageSources } from "@/features/chat/composer-sources";
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
