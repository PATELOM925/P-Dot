import type { McpServerId } from "@/lib/connectors";
import type { ToolItem } from "./ComposerTools";

/** What the "Use Google" item can do here (decision 0014). Null hides it: Google is not set up. */
export type GoogleChatState = "connected" | "not_connected" | "trial" | null;

/** The outside sources of the next message. At most one kind is on: web search, Google or apps. */
export interface MessageSources {
  webSearch: boolean;
  useGoogle: boolean;
  apps: McpServerId[];
}

/**
 * Turns one source on or off (`web`, `google` or `app:<id>`). Turning one kind
 * on turns the other kinds off; several apps together stay on. The request
 * schema refuses two kinds in one message (decisions 0014 and 0016).
 */
export function toggleSource(sources: MessageSources, key: string, connectedApps: readonly McpServerId[]): MessageSources {
  if (key === "web") {
    return sources.webSearch ? { ...sources, webSearch: false } : { webSearch: true, useGoogle: false, apps: [] };
  }
  if (key === "google") {
    return sources.useGoogle ? { ...sources, useGoogle: false } : { webSearch: false, useGoogle: true, apps: [] };
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
