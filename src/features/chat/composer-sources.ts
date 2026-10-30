import type { McpServerId } from "@/lib/connectors";
import type { ToolItem } from "./ComposerTools";

/** What the "Use Google" item can do here (decision 0014). Null hides it: Google is not set up. */
export type GoogleChatState = "connected" | "not_connected" | "trial" | null;

/** The outside sources of the next message. At most one kind is on: web search, Google or apps. */
export interface MessageSources {
  webSearch: boolean;
  useGoogle: boolean;
  apps: McpServerId[];
  /** Deep research (decision 0018): a kind of web search, so `webSearch` is on with it. */
  research?: true;
}

/**
 * Turns one source on or off (`web`, `research`, `google` or `app:<id>`).
 * Turning one kind on turns the other kinds off; several apps together stay
 * on. Web search and deep research replace each other. The request schema
 * refuses two kinds in one message (decisions 0014, 0016 and 0018).
 */
export function toggleSource(sources: MessageSources, key: string, connectedApps: readonly McpServerId[]): MessageSources {
  const plain = { webSearch: sources.webSearch, useGoogle: sources.useGoogle, apps: sources.apps };
  if (key === "web") {
    return sources.webSearch && !sources.research ? { ...plain, webSearch: false } : { webSearch: true, useGoogle: false, apps: [] };
  }
  if (key === "research") {
    return sources.research ? { ...plain, webSearch: false } : { webSearch: true, useGoogle: false, apps: [], research: true };
  }
  if (key === "google") {
    return sources.useGoogle ? { ...plain, useGoogle: false } : { webSearch: false, useGoogle: true, apps: [] };
  }
  const app = connectedApps.find((id) => `app:${id}` === key);
  if (!app) return sources;
  if (sources.apps.includes(app)) return { ...sources, apps: sources.apps.filter((a) => a !== app) };
  return { webSearch: false, useGoogle: false, apps: [...sources.apps, app] };
}

/** The "Use Google" row of the "+" menu, or null when Google is not set up. */
export function googleToolItem(google: GoogleChatState, on: boolean): ToolItem | null {
  if (google === null) return null;
  const item = { key: "google", title: "Use Google", chip: "Google", chipClass: "chip-app", icon: "google" } as const;
  if (google === "trial") {
    return { ...item, description: "Create an account to use Google.", on: false, unavailable: {} };
  }
  if (google === "not_connected") {
    return { ...item, description: "Not connected. Open Connectors to connect Google.", on: false, unavailable: { href: "/connectors#google" } };
  }
  return { ...item, description: "Gmail and calendar for this message. Asks before it sends or adds.", on };
}
