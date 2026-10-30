import Link from "next/link";
import { LocalTime } from "@/components/ui/LocalTime";
import type { ConversationSummary, ReminderDTO } from "@/types/api";
import { SectionBody, SectionControls } from "./TodaySection";

/** Scheduled reminders, soonest first. */
export function upcomingReminders(reminders: ReminderDTO[]): ReminderDTO[] {
  return reminders.filter((reminder) => reminder.status === "scheduled").sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

export function UpNext({ reminders }: { reminders: ReminderDTO[] }) {
  const upcoming = upcomingReminders(reminders);
  return (
    <section className="panel" id="up-next" aria-labelledby="up-next-heading">
      <div className="panel-heading">
        <h2 id="up-next-heading">Up next</h2>
        <Link href="#workflows">All reminders</Link>
        <SectionControls />
      </div>
      <SectionBody>
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
      </SectionBody>
    </section>
  );
}

export function RecentChats({ conversations }: { conversations: ConversationSummary[] }) {
  return (
    <section className="panel" id="recent-chats" aria-labelledby="recent-chats-heading">
      <div className="panel-heading">
        <h2 id="recent-chats-heading">Recent chats</h2>
        <Link href="/chat">Open chat</Link>
        <SectionControls />
      </div>
      <SectionBody>
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
      </SectionBody>
    </section>
  );
}
