import type { Metadata } from "next";
import { RemindersPanel } from "@/features/reminders/RemindersPanel";
import { REMINDER_LIST_LIMIT } from "@/lib/limits";
import { requireAuth } from "@/server/auth/session";
import { createReminderRepository } from "@/server/db/reminders";
import { getMode } from "@/server/mode";

export const metadata: Metadata = { title: "Workflows · P-Dot" };

// Planned routines, shown as a preview. None of these run yet.
const PLANNED = [
  {
    name: "Morning brief",
    when: "Every weekday at 7:30",
    steps: ["Read today's calendar and unread email", "Write a short brief and a to-do list", "Send it to Telegram"],
  },
  {
    name: "Meeting summary",
    when: "After each meeting you mark as done",
    steps: ["Summarise the notes you paste or upload", "List action items as tasks", "Ask you before emailing the summary"],
  },
  {
    name: "Book an appointment",
    when: "When you ask in chat",
    steps: ["Find open times in your calendar", "Ask you to approve the time", "Call or message the provider to book"],
  },
  {
    name: "Weekly review",
    when: "Fridays at 16:00",
    steps: ["Collect finished tasks and open pull requests", "Draft a status update for you to edit"],
  },
];

export default async function WorkflowsPage() {
  const auth = await requireAuth("/workflows");
  const mode = await getMode();
  const reminders = await createReminderRepository(auth.supabase).listReminders(
    auth.userId,
    mode,
    REMINDER_LIST_LIMIT,
  );

  return (
    <main className="page page-wide stack">
      <div>
        <h1>Workflows</h1>
        <p className="muted">
          Reminders and repeatable routines. Anything that sends, books or deletes will wait for your approval.
        </p>
      </div>

      <RemindersPanel key={mode} mode={mode} initialReminders={reminders} />

      <div className="section-heading">
        <h2>Planned routines</h2>
        <p className="muted">
          Routines are not available yet. They need connectors and a scheduler, which are still being planned. These
          cards preview what they will look like; nothing here runs.
        </p>
      </div>

      <div className="card-grid">
        {PLANNED.map((workflow) => (
          <article key={workflow.name} className="panel">
            <div className="panel-heading">
              <h3>{workflow.name}</h3>
              <span className="status-pill">Coming soon</span>
            </div>
            <p className="muted">{workflow.when}</p>
            <ol className="plain-list">
              {workflow.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </article>
        ))}
      </div>
    </main>
  );
}
