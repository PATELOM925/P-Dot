// Where P-Dot's suggestions go in a conversation: under the reply of the turn
// they came from. Pure functions, so they are unit-tested.
import type { MessageRole } from "@/types/api";

interface PlacedMessage {
  id: string;
  role: MessageRole;
  createdAt: string;
  /** Shown before the server saved it, so it has no server time and anchors nothing. */
  pending?: boolean;
}

export interface Placement<T> {
  /** Items to show under a message, by message ID, in their original order. */
  byMessage: Map<string, T[]>;
  /** Items that belong to no loaded turn. They are shown after the messages. */
  rest: T[];
}

/** The message a turn's suggestions go under: its first reply, or its user message while it has none. */
function turnAnchor(messages: PlacedMessage[], userIndex: number): string {
  for (let i = userIndex + 1; i < messages.length && messages[i]!.role !== "user"; i++) {
    if (!messages[i]!.pending) return messages[i]!.id;
  }
  return messages[userIndex]!.id;
}

function add<T>(map: Map<string, T[]>, key: string, item: T) {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

/** Index of the turn an item made at `createdAt` belongs to: the last saved user message at or before it, or -1. */
function turnIndexAt(messages: PlacedMessage[], createdAt: string): number {
  const time = Date.parse(createdAt);
  if (Number.isNaN(time)) return -1;
  let userIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== "user" || message.pending) continue;
    if (Date.parse(message.createdAt) <= time) userIndex = i;
    else break;
  }
  return userIndex;
}

/** The ID of the user message that starts the turn an item belongs to, or null. */
export function turnStartFor(messages: PlacedMessage[], createdAt: string): string | null {
  const index = turnIndexAt(messages, createdAt);
  return index === -1 ? null : messages[index]!.id;
}

/**
 * Places items made while a turn was running, such as action proposals. A turn
 * starts with a user message, so an item belongs to the last saved user
 * message created at or before it. Message and item times both come from the
 * database clock.
 */
export function placeByTime<T extends { createdAt: string }>(messages: PlacedMessage[], items: T[]): Placement<T> {
  const byMessage = new Map<string, T[]>();
  const rest: T[] = [];
  for (const item of items) {
    const userIndex = turnIndexAt(messages, item.createdAt);
    if (userIndex === -1) rest.push(item);
    else add(byMessage, turnAnchor(messages, userIndex), item);
  }
  return { byMessage, rest };
}

/**
 * Places items that name the message they came from, such as memories P-Dot
 * suggested. A suggestion from a user message goes under that turn's reply.
 * Suggestions from messages that are not loaded are left out; the Memory page
 * lists every suggestion.
 */
export function placeBySource<T extends { sourceMessageId: string | null }>(
  messages: PlacedMessage[],
  items: T[],
): Map<string, T[]> {
  const byMessage = new Map<string, T[]>();
  for (const item of items) {
    const index = messages.findIndex((m) => m.id === item.sourceMessageId && !m.pending);
    if (index === -1) continue;
    add(byMessage, messages[index]!.role === "user" ? turnAnchor(messages, index) : messages[index]!.id, item);
  }
  return byMessage;
}
