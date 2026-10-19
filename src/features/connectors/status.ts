// Live status lines for the built-in tools on the Connectors page. Pure, so it is unit-tested.
import type { DocumentDTO, MemoryDTO, ReminderDTO, TaskDTO } from "@/types/api";

interface Noun {
  one: string;
  many: string;
}

/**
 * "3 open tasks". `capped` means the list stopped at its limit, so there may
 * be more than were counted: "200+ open tasks", or "No recent open tasks".
 */
export function countPhrase(count: number, noun: Noun, capped: boolean): string {
  if (count === 0) return capped ? `No recent ${noun.many}` : `No ${noun.many}`;
  return `${count}${capped ? "+" : ""} ${count === 1 && !capped ? noun.one : noun.many}`;
}

export interface BuiltInLists {
  tasks: TaskDTO[];
  reminders: ReminderDTO[];
  memories: MemoryDTO[];
  documents: DocumentDTO[];
}

/** `now` decides which scheduled reminders are overdue; due times are instants, so no time zone is involved. */
export function builtInStatus(lists: BuiltInLists, limits: Record<keyof BuiltInLists, number>, now: number) {
  const capped = (key: keyof BuiltInLists) => lists[key].length >= limits[key];
  const active = lists.memories.filter((m) => m.status === "active").length;
  const waiting = lists.memories.length - active;
  const remembered = countPhrase(active, { one: "memory", many: "memories" }, capped("memories"));
  const scheduled = lists.reminders.filter((r) => r.status === "scheduled");
  const overdue = scheduled.filter((r) => Date.parse(r.dueAt) < now).length;
  const upcoming = countPhrase(
    scheduled.length - overdue,
    { one: "upcoming reminder", many: "upcoming reminders" },
    capped("reminders"),
  );

  return {
    tasks: countPhrase(
      lists.tasks.filter((t) => !t.done).length,
      { one: "open task", many: "open tasks" },
      capped("tasks"),
    ),
    reminders: overdue > 0 ? `${upcoming}, ${overdue} overdue` : upcoming,
    memory: waiting > 0 ? `${remembered}, ${waiting} waiting for you` : remembered,
    documents: countPhrase(
      lists.documents.filter((d) => d.status === "ready").length,
      { one: "document ready", many: "documents ready" },
      capped("documents"),
    ),
  };
}
