import { BRIEF_MAX_TOPICS, BRIEF_TOPIC_CHARS } from "@/lib/limits";
import type { ChatRequest, Mode } from "@/types/api";

/** The Topics field is kept in this browser only, one value for each mode. No database row. */
export function briefTopicsKey(mode: Mode): string {
  return `pdot.brief.topics.${mode}`;
}

/** Up to 3 unique topics from a comma or semicolon list. A topic that is too long is cut. */
export function parseTopics(text: string): string[] {
  const topics: string[] = [];
  for (const part of text.split(/[,;\n]/)) {
    const topic = part.replace(/\s+/g, " ").trim().slice(0, BRIEF_TOPIC_CHARS).trim();
    if (topic && !topics.some((known) => known.toLowerCase() === topic.toLowerCase())) topics.push(topic);
    if (topics.length >= BRIEF_MAX_TOPICS) break;
  }
  return topics;
}

/** Topics from the mode's active memories, for an empty Topics field. The user sees and edits them first. */
export function topicsFromMemories(memories: string[]): string {
  return memories
    .map((memory) => memory.replace(/\s+/g, " ").trim().slice(0, BRIEF_TOPIC_CHARS).trim())
    .filter(Boolean)
    .slice(0, BRIEF_MAX_TOPICS)
    .join(", ");
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The user's local date, for example "Fri 30 Oct 2026". Fixed words, so the server accepts every locale. */
export function localBriefDate(now: Date): string {
  return `${WEEKDAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
}

/** The chat request that makes the brief: a new conversation in this mode, with no other source. */
export function briefRequest(mode: Mode, topics: string[], date: string): ChatRequest {
  return {
    action: "send",
    mode,
    message: `Make my morning brief for ${date}. Topics: ${topics.join("; ")}.`,
    webSearch: false,
    brief: { topics, date },
  };
}
