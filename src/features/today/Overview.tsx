import Link from "next/link";
import { Greeting } from "@/components/ui/Greeting";
import { LocalTime } from "@/components/ui/LocalTime";
import { Mascot } from "@/components/ui/Mascot";
import { MAX_MESSAGE_CHARS } from "@/lib/limits";
import type { ActionProposalDTO, ConversationSummary, MemoryDTO, Mode, ReminderDTO, TaskDTO } from "@/types/api";

interface OverviewProps {
  mode: Mode;
  /** A first name for the greeting, or null. */
  name?: string | null;
  tasks: TaskDTO[];
  reminders: ReminderDTO[];
  memories: MemoryDTO[];
  proposals: ActionProposalDTO[];
  conversations: ConversationSummary[];
}

const PLACEHOLDER: Record<Mode, string> = {
  personal: "Plan dinner, shortlist a gift, sort out the weekend…",
  work: "Draft an update, plan the week, work through a problem…",
};

const IDEAS: Record<Mode, string[]> = {
  personal: ["Plan a simple dinner for tonight", "Help me choose a gift under 30 dollars", "Remind me to call mum on Sunday at 6 pm"],
  work: ["Help me draft a short status update", "Plan my week around three priorities", "Remind me to send the report tomorrow at 9 am"],
};

/**
 * The top of the Today page: what is open, what is next, and a box that opens
 * chat with the question already typed. Everything comes from the user's own
 * rows (tasks, reminders, memories, approvals, conversations) for this mode.
 */
export function Overview({ mode, name = null, tasks, reminders, memories, proposals, conversations }: OverviewProps) {
  const openTasks = tasks.filter((task) => !task.done).length;
  const upcoming = reminders
    .filter((reminder) => reminder.status === "scheduled")
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const waiting = proposals.filter((proposal) => proposal.status === "proposed").length;
  const remembered = memories.filter((memory) => memory.status === "active").length;

  const tiles = [
    { label: "Open tasks", value: openTasks, href: "#tasks", tone: "tile-accent", icon: "M5 12l4 4 10-10" },
    { label: "Reminders ahead", value: upcoming.length, href: "#workflows", tone: "tile-work", icon: "M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z" },
    { label: "Waiting for you", value: waiting, href: "#approvals", tone: "tile-warm", icon: "M12 4v9M12 17.5v.5M4.5 19h15L12 4 4.5 19z" },
    { label: "Remembered", value: remembered, href: "/memory", tone: "tile-mint", icon: "M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z" },
  ];

  return (
    <section className="overview" aria-labelledby="overview-heading">
      <div className="overview-hero">
        <Mascot className="overview-mascot" size={72} float />
        <p className="overview-eyebrow">
          <Greeting name={name} />
        </p>
        <h2 id="overview-heading" className="overview-title">
          {mode === "work" ? "What should we move forward?" : "What can I take off your plate?"}
        </h2>
        <form className="quick-ask" action="/chat" method="get">
          <label htmlFor="quick-ask-input" className="visually-hidden">
            Ask P-Dot
          </label>
          <input
            id="quick-ask-input"
            name="ask"
            type="text"
            maxLength={MAX_MESSAGE_CHARS}
            placeholder={PLACEHOLDER[mode]}
            autoComplete="off"
          />
          <button type="submit" className="button button-primary">
            Ask
          </button>
        </form>
        <ul className="idea-row" aria-label="Ideas">
          {IDEAS[mode].map((idea) => (
            <li key={idea}>
              <Link className="idea-chip" href={`/chat?ask=${encodeURIComponent(idea)}`}>
                {idea}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <ul className="tile-grid" aria-label="At a glance">
        {tiles.map((tile) => (
          <li key={tile.label}>
            <Link className={`tile ${tile.tone}`} href={tile.href}>
              <svg className="tile-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={tile.icon} />
              </svg>
              <span className="tile-value">{tile.value}</span>
              <span className="tile-label">{tile.label}</span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="overview-lists">
        <div className="panel">
          <div className="panel-heading">
            <h3>Up next</h3>
            <Link href="#workflows">All reminders</Link>
          </div>
          {upcoming.length === 0 ? (
            <p className="muted">No reminders scheduled. Ask P-Dot to remind you of something and approve it.</p>
          ) : (
            <ul className="mini-list">
              {upcoming.slice(0, 3).map((reminder) => (
                <li key={reminder.id}>
                  <span className="mini-title">{reminder.title}</span>
                  <span className="muted small">
                    <LocalTime iso={reminder.dueAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel">
          <div className="panel-heading">
            <h3>Recent chats</h3>
            <Link href="/chat">Open chat</Link>
          </div>
          {conversations.length === 0 ? (
            <p className="muted">No conversations in this mode yet.</p>
          ) : (
            <ul className="mini-list">
              {conversations.slice(0, 4).map((conversation) => (
                <li key={conversation.id}>
                  <Link className="mini-title" href={`/chat?c=${encodeURIComponent(conversation.id)}`}>
                    {conversation.title}
                  </Link>
                  <span className="muted small">
                    <LocalTime iso={conversation.updatedAt} style="date" />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
