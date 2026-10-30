import type { McpServerId } from "@/lib/connectors";
import { googleWords } from "@/lib/google-words";
import { detectToolIntent } from "@/lib/tool-intent";
import type { ToolItem } from "./ComposerTools";

/** What the "Use Google" item can do here (decision 0014). Null hides it: Google is not set up. */
export type GoogleChatState = "connected" | "not_connected" | "trial" | null;

/** The outside sources of the next message. Web search, Google and apps can be on together (decision 0021). */
export interface MessageSources {
  webSearch: boolean;
  useGoogle: boolean;
  apps: McpServerId[];
  /** Deep research (decision 0018): a kind of web search, so `webSearch` is on with it, and Google and the apps are off. */
  research?: true;
}

/**
 * Turns one source on or off (`web`, `research`, `google` or `app:<id>`).
 * Web search, Google and any apps stay on together. Deep research is web
 * only: turning it on turns Google and the apps off, and turning Google or an
 * app on turns it off. Web search and deep research replace each other. The
 * request schema refuses deep research with Google or an app (decision 0021).
 */
export function toggleSource(sources: MessageSources, key: string, connectedApps: readonly McpServerId[]): MessageSources {
  // Without deep research: a private source turned on keeps plain web search, but not deep research.
  const plain = sources.research
    ? { webSearch: false, useGoogle: sources.useGoogle, apps: sources.apps }
    : { webSearch: sources.webSearch, useGoogle: sources.useGoogle, apps: sources.apps };
  if (key === "web") {
    return sources.webSearch && !sources.research ? { ...plain, webSearch: false } : { ...plain, webSearch: true };
  }
  if (key === "research") {
    return sources.research ? plain : { webSearch: true, useGoogle: false, apps: [], research: true };
  }
  if (key === "google") {
    return { ...plain, useGoogle: !sources.useGoogle };
  }
  const app = connectedApps.find((id) => `app:${id}` === key);
  if (!app) return sources;
  if (sources.apps.includes(app)) return { ...plain, apps: sources.apps.filter((a) => a !== app) };
  return { ...plain, apps: [...sources.apps, app] };
}

/** The "Use Google" row of the "+" menu, or null when Google is not set up. */
export function googleToolItem(google: GoogleChatState, on: boolean): ToolItem | null {
  if (google === null) return null;
  const item = { key: "google", title: "Use Google", chip: "Google", chipClass: "chip-app", icon: "google", brand: "google" } as const;
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
  github: /\bgithub\b/i,
};

const noneOn = (sources: MessageSources) => !sources.webSearch && !sources.useGoogle && sources.apps.length === 0;

/**
 * The sources a message uses when the user picked none (decisions 0014, 0016
 * and 0021). Each connected app that the message names turns on. Google turns
 * on for a message about email or the calendar; with an app named, only for a
 * strong word ("email", "calendar"), so "my meeting notes in Notion" stays on
 * Notion. A request for a task, a reminder or a memory does not turn Google on
 * ("Remind me to mail the package"), except a request to schedule a meeting or
 * a call. Web search never turns on by itself. A manual pick always wins, and
 * the composer shows the result as chips.
 */
export function autoSources(
  message: string,
  picked: MessageSources,
  google: GoogleChatState,
  connectedApps: readonly McpServerId[],
): MessageSources {
  if (!noneOn(picked) || !message.trim()) return picked;
  const apps = connectedApps.filter((app) => APP_NAMES[app].test(message));
  const useGoogle = google === "connected" && googleNamed(message, apps.length > 0);
  if (apps.length === 0 && !useGoogle) return picked;
  return { webSearch: false, useGoogle, apps };
}

function googleNamed(message: string, appNamed: boolean): boolean {
  const words = googleWords(message);
  if (!words.mail && !words.calendar) return false;
  if (appNamed && !words.strong) return false;
  const intent = detectToolIntent(message);
  return !((intent === "task_request" || intent === "memory_request") && !words.scheduleMeeting);
}
