import type { McpServerId } from "@/lib/connectors";
import { googleWords } from "@/lib/google-words";
import { detectToolIntent } from "@/lib/tool-intent";
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

/**
 * How a message names each app. "notion" and "linear" are also plain words, so
 * "the notion of" and "linear algebra" do not match. A new app id must add
 * its pattern here: the Record type requires it.
 */
const APP_NAMES: Record<McpServerId, RegExp> = {
  notion: /\bnotion\b(?!\s+(?:of|that)\b)/i,
  // Case matters here: "in Linear" names the app, "in linear time" does not.
  linear: /\b(?:[Ii]n|[Oo]n|[Ff]rom|[Cc]heck|[Oo]pen)\s+Linear\b|\b[Mm]y\s+[Ll]inear\b|\b[Ll]inear\s+(?:issues?|tickets?|projects?|board|cycles?|workspace|account)\b/,
  todoist: /\btodoist\b/i,
};

const noneOn = (sources: MessageSources) => !sources.webSearch && !sources.useGoogle && sources.apps.length === 0;

/**
 * The sources a message uses when the user picked none (decisions 0014 and
 * 0016). A connected app that the message names turns on; several apps can.
 * Otherwise Google turns on for a message about email or the calendar. A
 * request for a task, a reminder or a memory does not turn Google on ("Remind
 * me to mail the package"), except a request to schedule a meeting or a call.
 * A manual pick always wins, and the composer shows the result as chips.
 */
export function autoSources(
  message: string,
  picked: MessageSources,
  google: GoogleChatState,
  connectedApps: readonly McpServerId[],
): MessageSources {
  if (!noneOn(picked) || !message.trim()) return picked;
  const apps = connectedApps.filter((app) => APP_NAMES[app].test(message));
  if (apps.length > 0) return { webSearch: false, useGoogle: false, apps };
  if (google !== "connected") return picked;
  const words = googleWords(message);
  if (!words.mail && !words.calendar) return picked;
  const intent = detectToolIntent(message);
  if ((intent === "task_request" || intent === "memory_request") && !words.scheduleMeeting) return picked;
  return { webSearch: false, useGoogle: true, apps: [] };
}
