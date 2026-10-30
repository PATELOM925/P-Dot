import { CardRail } from "@/components/ui/CardRail";
import { RemindersPanel } from "@/features/reminders/RemindersPanel";
import { SectionBody, SectionControls } from "@/features/today/TodaySection";
import { REMINDER_LIST_LIMIT } from "@/lib/limits";
import type { AuthContext } from "@/server/auth/session";
import { createReminderRepository } from "@/server/db/reminders";
import type { Mode } from "@/types/api";

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

/** Reminders and planned routines, on the Today page. The old /workflows address redirects here. */
export async function WorkflowsSection({ auth, mode }: { auth: AuthContext; mode: Mode }) {
  const reminders = await createReminderRepository(auth.supabase).listReminders(auth.userId, mode, REMINDER_LIST_LIMIT);

  return (
    <section id="workflows" className="stack" aria-labelledby="workflows-heading">
      <div className="panel-heading">
        <h2 id="workflows-heading">Workflows</h2>
        <SectionControls />
      </div>
      <SectionBody>
        <RemindersPanel key={mode} mode={mode} initialReminders={reminders} />
        <CardRail
          title="Planned routines"
          level={3}
          intro={<p className="muted small">Not available yet. Nothing here runs.</p>}
        >
          {PLANNED.map((workflow) => (
            <article key={workflow.name} className="panel">
              <div className="panel-heading">
                <h4>{workflow.name}</h4>
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
        </CardRail>
      </SectionBody>
    </section>
  );
}
