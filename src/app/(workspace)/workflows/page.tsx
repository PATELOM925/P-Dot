import type { Metadata } from "next";
import { requireAuth } from "@/server/auth/session";

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
  await requireAuth("/workflows");

  return (
    <main className="page page-wide stack">
      <div>
        <h1>Workflows</h1>
        <p className="muted">
          Repeatable routines P-Dot will run for you. Anything that sends, books or deletes will wait for your approval.
        </p>
      </div>

      <p className="alert alert-warning" role="status">
        Workflows are not available yet. They need connectors and a scheduler, which are still being planned. This page
        previews what they will look like; nothing here runs.
      </p>

      <div className="card-grid">
        {PLANNED.map((workflow) => (
          <article key={workflow.name} className="panel">
            <div className="panel-heading">
              <h2>{workflow.name}</h2>
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
