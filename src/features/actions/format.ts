// Display helpers for action proposals and the action log. Pure functions, so they are unit-tested.
import { MODE_LABELS } from "@/lib/mode";
import type {
  ActionKind,
  ActionLogEntryDTO,
  ActionLogEvent,
  ActionPayload,
  ActionProposalDTO,
  ActionStatus,
  Mode,
} from "@/types/api";

export const KIND_LABELS: Record<ActionKind, string> = {
  create_task: "Add a task",
  create_reminder: "Set a reminder",
  save_memory: "Remember something",
  send_email: "Send an email",
  create_calendar_event: "Add a calendar event",
};

/** Kinds that act in the user's Google account. They always ask, and they cannot be edited on the card. */
export const isExternalKind = (kind: ActionKind) => kind === "send_email" || kind === "create_calendar_event";

/** Where the user checks an external action whose outcome P-Dot does not know. */
export const EXTERNAL_CHECK_PLACE: Record<"send_email" | "create_calendar_event", string> = {
  send_email: "the Sent folder in Gmail",
  create_calendar_event: "Google Calendar",
};

/** Where the result of an executed action can be seen. */
export const KIND_RESULT_LINKS: Record<ActionKind, { href: string; label: string }> = {
  create_task: { href: "/today", label: "Open your to-do list" },
  create_reminder: { href: "/today#workflows", label: "Open your reminders" },
  save_memory: { href: "/memory", label: "Open what P-Dot remembers" },
  send_email: { href: "https://mail.google.com/mail/#sent", label: "Open your Sent folder in Gmail" },
  create_calendar_event: { href: "https://calendar.google.com/", label: "Open Google Calendar" },
};

const FAILURE_REASONS: Record<string, string> = {
  not_connected: "Google was not connected. Nothing was sent.",
  needs_reconnect: "Google access ended. Nothing was sent. Connect Google again on the Connectors page.",
  scope_missing: "Your Google connection does not allow this. Nothing was sent.",
  google_rejected: "Google refused this action. Nothing was sent.",
  account_changed: "The connected Google account changed before P-Dot acted. Nothing was sent.",
  not_done: "You said this was not done.",
};

/** Why a failed action failed, in the user's words. */
export function failureText(proposal: Pick<ActionProposalDTO, "result">): string {
  const reason = proposal.result?.reason;
  return (typeof reason === "string" && FAILURE_REASONS[reason]) || "This action could not be completed. Nothing else was changed.";
}

/**
 * Said next to an action that is marked done but that the database did not
 * confirm: decide_action_proposal did not decide it (decision 0009). Older
 * history, or an outcome a caller wrote, looks like this.
 */
export const UNCONFIRMED_HINT = "P-Dot did not confirm this action.";

/** True when a proposal is marked done but the database did not confirm it. */
export function isUnconfirmedDone(proposal: Pick<ActionProposalDTO, "status" | "verified">): boolean {
  return proposal.status === "executed" && proposal.verified !== true;
}

export interface PastProposalView {
  label: string;
  /** CSS class of the status pill. */
  pill: string;
  note: string;
  /** Show the link to where the result can be seen. Only for a confirmed result. */
  showResult: boolean;
}

// "Approved" rather than "you approved": until the server records who decided (decision 0011),
// an approval made by Auto mode looks the same as one made with a click.
const PAST: Record<Exclude<ActionStatus, "proposed">, PastProposalView> = {
  approved: { label: "Running", pill: "status-approved", note: "Approved. It is still running.", showResult: false },
  executing: {
    label: "In progress",
    pill: "status-approved",
    note: "Approved. P-Dot is finishing it, or does not know yet if it was done.",
    showResult: false,
  },
  executed: { label: "Done", pill: "status-executed", note: "Approved and done.", showResult: true },
  rejected: { label: "Cancelled", pill: "status-rejected", note: "You cancelled it. Nothing was changed.", showResult: false },
  failed: { label: "Failed", pill: "status-failed", note: "Approved, but it could not be completed.", showResult: false },
};

const UNCONFIRMED_PAST: PastProposalView = {
  label: "Marked done",
  pill: "status-unconfirmed",
  note: UNCONFIRMED_HINT,
  showResult: false,
};

/** How chat shows a decided proposal. A done action that the database did not confirm is "Marked done". */
export function pastProposalView(proposal: ActionProposalDTO): PastProposalView | null {
  if (proposal.status === "proposed") return null;
  return isUnconfirmedDone(proposal) ? UNCONFIRMED_PAST : PAST[proposal.status];
}

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
    case "send_email":
      return [["To", payload.to.join(", ")], ["Subject", payload.subject], ["Message", payload.body], mode];
    case "create_calendar_event": {
      const rows: [string, string][] = [
        ["Event", payload.title],
        ["Starts", formatDate(payload.start)],
        ["Ends", formatDate(payload.end)],
        ["Guests", payload.attendees.length > 0 ? payload.attendees.join(", ") : "None"],
      ];
      if (payload.attendees.length > 0) rows.push(["Invitations", "Google emails an invitation to each guest."]);
      return [...rows, mode];
    }
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
 * A proposal that needs the user: one waiting for a decision, or an external
 * action still "executing" (it has recovery controls, decision 0014). Read
 * from the server's status, so it stays after a reload.
 */
export function needsUser(proposal: Pick<ActionProposalDTO, "status">): boolean {
  return proposal.status === "proposed" || proposal.status === "executing";
}

/** Milliseconds until an external action's lease ends, 0 when it has ended or the start time is unknown. */
export function leaseRemainingMs(executionStartedAt: string | null | undefined, now: number, leaseSeconds: number): number {
  const started = executionStartedAt ? Date.parse(executionStartedAt) : Number.NaN;
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, started + leaseSeconds * 1000 - now);
}

/**
 * How long to wait before the card checks the lease again, from the clock at
 * scheduling time. 0 when the lease has ended, so the card updates at once.
 * A renewed lease (a later start time) gives its full length again.
 */
export function leaseTimerDelayMs(executionStartedAt: string | null | undefined, now: number, leaseSeconds: number): number {
  const remaining = leaseRemainingMs(executionStartedAt, now, leaseSeconds);
  return remaining === 0 ? 0 : remaining + 500;
}

/**
 * What an approval list shows: proposals that need the user, plus the ones
 * decided in this view so their outcome stays visible. Also counts proposals waiting
 * in the other mode, which the Today page mentions.
 */
export function visibleProposals(
  proposals: ActionProposalDTO[],
  filter: ProposalFilter,
  decidedHere: ReadonlySet<string>,
): { visible: ActionProposalDTO[]; waitingInOtherMode: number } {
  const visible = proposals.filter(
    (p) => matchesFilter(p, filter) && (needsUser(p) || decidedHere.has(p.id)),
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
  document_ready: "Document ready to search",
  document_failed: "Document could not be processed",
  document_deleted: "Document deleted",
  reminder_added: "Reminder added",
  reminder_changed: "Reminder changed",
  reminder_deleted: "Reminder deleted",
};

const KIND_NOUNS: Record<string, string> = {
  create_task: "Task",
  create_reminder: "Reminder",
  save_memory: "Memory",
  send_email: "Email",
  create_calendar_event: "Calendar event",
};

const STATUS_WORDS: Record<string, string> = {
  scheduled: "Scheduled",
  done: "Marked done",
  cancelled: "Cancelled",
  proposed: "Waiting for approval",
  active: "Active",
  processing: "Processing",
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
  if (detail.userConfirmed === true) facts.push("You said it was done");

  // Only a row the database wrote for a confirmed outcome says "completed".
  if (entry.event === "executed" && entry.verified !== true) {
    return { title: "Marked as completed", facts: [...facts, UNCONFIRMED_HINT], tone: "neutral" };
  }

  const tone: LogTone =
    entry.event === "executed"
      ? "success"
      : entry.event === "failed" || entry.event === "document_failed"
        ? "danger"
        : entry.event === "proposed"
          ? "warning"
          : "neutral";

  return { title: EVENT_LABELS[entry.event] ?? entry.event.replaceAll("_", " "), facts, tone };
}
