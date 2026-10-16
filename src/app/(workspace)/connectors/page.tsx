import type { Metadata } from "next";
import { requireAuth } from "@/server/auth/session";

export const metadata: Metadata = { title: "Connectors · P-Dot" };

// Planned connectors, shown as a preview. None can be connected yet.
const PLANNED = [
  { name: "Gmail", can: "read and summarise mail, draft replies", asks: "before sending or deleting" },
  { name: "Calendar", can: "read events and find free time", asks: "before creating or changing events" },
  { name: "Telegram", can: "deliver your daily brief and to-do list to your own chat", asks: "before messaging anyone else" },
  { name: "GitHub", can: "read pull requests and issues you can see", asks: "before commenting, merging or changing anything" },
  { name: "Vercel", can: "report deploy status and errors", asks: "before deploying or changing settings" },
  { name: "WhatsApp", can: "send you briefs and reminders", asks: "before every message to another person" },
  { name: "Phone calls", can: "call to book appointments for you", asks: "before every call, with the number and purpose shown" },
];

export default async function ConnectorsPage() {
  await requireAuth("/connectors");

  return (
    <main className="page page-wide stack">
      <div>
        <h1>Connectors</h1>
        <p className="muted">
          Accounts P-Dot will be able to read from. You will choose what it can see, and it will ask before it sends, books
          or deletes anything.
        </p>
      </div>

      <p className="alert alert-warning" role="status">
        Connectors are not available yet. They need secure account linking (OAuth), encrypted token storage and an
        approval flow, which are still being planned. This page previews the plan; nothing can be connected today.
      </p>

      <div className="card-grid">
        {PLANNED.map((connector) => (
          <article key={connector.name} className="panel">
            <div className="panel-heading">
              <h2>{connector.name}</h2>
              <span className="status-pill">Coming soon</span>
            </div>
            <p>
              <strong>Will:</strong> {connector.can}.
            </p>
            <p className="muted">
              <strong>Asks first:</strong> {connector.asks}.
            </p>
            <button type="button" className="button button-small" disabled>
              Connect
            </button>
          </article>
        ))}
      </div>
    </main>
  );
}
