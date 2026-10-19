// Display helpers for action proposals and the action log. Pure functions, so they are unit-tested.
import { MODE_LABELS } from "@/lib/mode";
import type { ActionKind, ActionLogEntryDTO, ActionLogEvent, ActionPayload, ActionProposalDTO, Mode } from "@/types/api";

export const KIND_LABELS: Record<ActionKind, string> = {
  create_task: "Add a task",
  create_reminder: "Set a reminder",
  save_memory: "Remember something",
};

/** Where the result of an executed action can be seen. */
export const KIND_RESULT_LINKS: Record<ActionKind, { href: string; label: string }> = {
  create_task: { href: "/today", label: "Open your to-do list" },
  create_reminder: { href: "/workflows", label: "Open your reminders" },
  save_memory: { href: "/memory", label: "Open what P-Dot remembers" },
};

/** The fields that will be used when the action runs, as label/value pairs. Built from the payload, never the summary. */
export function payloadDetails(payload: ActionPayload, formatDate: (iso: string) => string): [string, string][] {
  const mode: [string, string] = ["List", MODE_LABELS[payload.mode]];
  switch (payload.kind) {
    case "create_task":
      return [["Task", payload.title], mode];
    case "create_reminder":
      return [["Reminder", payload.title], ["Due", formatDate(payload.dueAt)], mode];
    case "save_memory":
      return [["Memory", payload.content], mode];
  }
}

export interface ProposalFilter {
  /** Only proposals from this conversation (chat). */
  conversationId?: string;
  /** Only proposals whose payload is for this mode (Today). */
  mode?: Mode;
}

export function matchesFilter(proposal: ActionProposalDTO, filter: ProposalFilter): boolean {
  return (
    (filter.conversationId === undefined || proposal.conversationId === filter.conversationId) &&
    (filter.mode === undefined || proposal.payload.mode === filter.mode)
  );
}

/**
 * What an approval list shows: proposals still waiting, plus the ones decided
 * in this view so their outcome stays visible. Also counts proposals waiting
 * in the other mode, which the Today page mentions.
 */
export function visibleProposals(
  proposals: ActionProposalDTO[],
  filter: ProposalFilter,
  decidedHere: ReadonlySet<string>,
): { visible: ActionProposalDTO[]; waitingInOtherMode: number } {
  const visible = proposals.filter(
    (p) => matchesFilter(p, filter) && (p.status === "proposed" || decidedHere.has(p.id)),
  );
  const waitingInOtherMode =
    filter.mode === undefined
      ? 0
      : proposals.filter(
          (p) =>
            p.status === "proposed" &&
            p.payload.mode !== filter.mode &&
            matchesFilter(p, { conversationId: filter.conversationId }),
        ).length;
  return { visible, waitingInOtherMode };
}

/** The value for an `<input type="datetime-local">`, in the browser's time zone. Empty when the date is invalid. */
export function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

/** An ISO 8601 date-time (UTC) from a datetime-local value, read in the browser's time zone. Null when invalid. */
export function fromLocalInputValue(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const EVENT_LABELS: Record<ActionLogEvent, string> = {
  proposed: "P-Dot proposed an action",
  approved: "You approved an action",
  rejected: "You cancelled an action",
  executed: "Action completed",
  failed: "Action failed",
  memory_added: "Memory added",
  memory_edited: "Memory changed",
  memory_deleted: "Memory deleted",
  document_added: "Document added",
  document_deleted: "Document deleted",
  reminder_added: "Reminder added",
  reminder_changed: "Reminder changed",
  reminder_deleted: "Reminder deleted",
};

const KIND_NOUNS: Record<string, string> = {
  create_task: "Task",
  create_reminder: "Reminder",
  save_memory: "Memory",
};

const STATUS_WORDS: Record<string, string> = {
  scheduled: "Scheduled",
  done: "Marked done",
  cancelled: "Cancelled",
  proposed: "Waiting for approval",
  active: "Active",
};

export type LogTone = "neutral" | "success" | "warning" | "danger";

export interface LogEntryView {
  title: string;
  /** Short facts from the entry's detail. IDs are left out. */
  facts: string[];
  tone: LogTone;
}

/** Turns a log entry into words. Unknown events and detail keys are shown generically, never dropped silently. */
export function describeLogEntry(entry: ActionLogEntryDTO): LogEntryView {
  const detail = entry.detail;
  const facts: string[] = [];
  if (typeof detail.kind === "string") facts.push(KIND_NOUNS[detail.kind] ?? detail.kind);
  if (detail.mode === "personal" || detail.mode === "work") facts.push(MODE_LABELS[detail.mode]);
  if (detail.source === "assistant") facts.push("Suggested by P-Dot");
  if (detail.source === "user") facts.push("Added by you");
  if (typeof detail.status === "string") facts.push(STATUS_WORDS[detail.status] ?? detail.status);
  if (typeof detail.chunkCount === "number") {
    facts.push(`${detail.chunkCount} searchable ${detail.chunkCount === 1 ? "part" : "parts"}`);
  }
  if (detail.edited === true) facts.push("Edited before approval");
  if (typeof detail.error === "string") facts.push("Could not be completed");

  const tone: LogTone =
    entry.event === "executed"
      ? "success"
      : entry.event === "failed"
        ? "danger"
        : entry.event === "proposed"
          ? "warning"
          : "neutral";

  return { title: EVENT_LABELS[entry.event] ?? entry.event.replaceAll("_", " "), facts, tone };
}
