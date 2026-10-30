import type { Metadata } from "next";
import Link from "next/link";
import { GoogleCard } from "@/features/connectors/GoogleCard";
import { googleCardState, googleOutcomeMessage } from "@/features/connectors/google";
import { builtInStatus } from "@/features/connectors/status";
import { DOCUMENT_LIST_LIMIT, MEMORY_LIST_LIMIT, REMINDER_LIST_LIMIT, TASK_LIST_LIMIT } from "@/lib/limits";
import { MODE_LABELS } from "@/lib/mode";
import { requireAuth, type AuthContext } from "@/server/auth/session";
import { getGoogleConfig } from "@/server/config";
import { createConnectedAccountRepository } from "@/server/db/connected-accounts";
import { createDocumentRepository } from "@/server/db/documents";
import { createMemoryRepository } from "@/server/db/memories";
import { createReminderRepository } from "@/server/db/reminders";
import { createTaskRepository } from "@/server/db/tasks";
import { getMode } from "@/server/mode";
import type { Mode } from "@/types/api";

export const metadata: Metadata = { title: "Connectors · P-Dot" };

// Planned connectors, shown as a preview. None can be connected yet.
const PLANNED = [
  { key: "telegram", name: "Telegram", can: "deliver your daily brief and to-do list to your own chat", asks: "before messaging anyone else" },
  { key: "github", name: "GitHub", can: "read pull requests and issues you can see", asks: "before commenting, merging or changing anything" },
  { key: "vercel", name: "Vercel", can: "report deploy status and errors", asks: "before deploying or changing settings" },
  { key: "whatsapp", name: "WhatsApp", can: "send you briefs and reminders", asks: "before every message to another person" },
  { key: "phone", name: "Phone calls", can: "call to book appointments for you", asks: "before every call, with the number and purpose shown" },
];

/** Reads the user's lists for one mode and turns them into status lines, as of the time of the request. */
async function loadBuiltInStatus(auth: AuthContext, mode: Mode) {
  const [tasks, reminders, memories, documents] = await Promise.all([
    createTaskRepository(auth.supabase).listTasks(auth.userId, mode, TASK_LIST_LIMIT),
    createReminderRepository(auth.supabase).listReminders(auth.userId, mode, REMINDER_LIST_LIMIT),
    createMemoryRepository(auth.supabase).listMemories(auth.userId, mode, undefined, MEMORY_LIST_LIMIT),
    createDocumentRepository(auth.supabase).listDocuments(auth.userId, mode, DOCUMENT_LIST_LIMIT),
  ]);
  return builtInStatus(
    { tasks, reminders, memories, documents },
    { tasks: TASK_LIST_LIMIT, reminders: REMINDER_LIST_LIMIT, memories: MEMORY_LIST_LIMIT, documents: DOCUMENT_LIST_LIMIT },
    Date.now(),
  );
}

/** The Google row without the token, or "load_failed". A failure here never breaks the rest of the page. */
async function loadGoogleConnection(auth: AuthContext) {
  try {
    return await createConnectedAccountRepository(auth.supabase).getGoogleConnection(auth.userId);
  } catch {
    return "load_failed" as const;
  }
}

interface ConnectorsPageProps {
  searchParams: Promise<{ google?: string | string[] }>;
}

export default async function ConnectorsPage({ searchParams }: ConnectorsPageProps) {
  const auth = await requireAuth("/connectors");
  const mode = await getMode();
  const configured = getGoogleConfig().status === "ready";
  const [status, google] = await Promise.all([
    loadBuiltInStatus(auth, mode),
    configured && !auth.isAnonymous ? loadGoogleConnection(auth) : Promise.resolve(null),
  ]);
  const googleMessage = googleOutcomeMessage((await searchParams).google);

  // P-Dot's own lists and files. The first three are the only things an approved action can change (decision 0009).
  const builtIn = [
    { name: "To-do list", href: "/today", link: "Open your to-do list", status: status.tasks, can: "add a task you approve." },
    { name: "Reminders", href: "/workflows", link: "Open your reminders", status: status.reminders, can: "set a reminder you approve." },
    { name: "Memory", href: "/memory", link: "Open what P-Dot remembers", status: status.memory, can: "remember something you approve." },
    {
      name: "Documents",
      href: "/memory#documents",
      link: "Open your documents",
      status: status.documents,
      can: "keep text and Markdown files you add. P-Dot can search them when you ask about your notes, documents or files.",
    },
  ];

  return (
    <main className="page page-wide stack">
      <div>
        <h1>Connectors</h1>
        <p className="muted">
          What P-Dot can work with. You choose what it can see, and it asks before it sends, books, changes or deletes
          anything. Every decision is written to the <Link href="/action-log">action log</Link>.
        </p>
      </div>

      <section className="stack" aria-labelledby="built-in-heading">
        <div className="section-heading">
          <h2 id="built-in-heading">Built in</h2>
          <p className="muted">
            P-Dot&apos;s own lists and files, shown for {MODE_LABELS[mode]} mode. An action proposed in chat can add to a
            list only after you approve it on its card.
          </p>
        </div>
        <div className="card-grid">
          {builtIn.map((tool) => (
            <article key={tool.name} className="panel">
              <div className="panel-heading">
                <h3>{tool.name}</h3>
                <span className="status-pill status-executed">Ready</span>
              </div>
              <p className="connector-status">{tool.status}</p>
              <p>
                <strong>Can:</strong> {tool.can}
              </p>
              <Link href={tool.href}>{tool.link}</Link>
            </article>
          ))}
          <article className="panel">
            <div className="panel-heading">
              <h3>Your devices</h3>
              <span className="status-pill">Coming soon</span>
            </div>
            <p>
              <strong>Will:</strong> act on your own laptop and phone, with your approval for each action.
            </p>
            <Link href="/devices">Open devices</Link>
          </article>
        </div>
      </section>

      <section className="stack" aria-labelledby="accounts-heading">
        <div className="section-heading">
          <h2 id="accounts-heading">Your accounts</h2>
          <p className="muted">
            Accounts you connect. P-Dot reads them only for a message where you allow it, and it asks before it sends or
            adds anything. Replies do not use Google yet; that step is still being built.
          </p>
        </div>
        <div className="card-grid">
          <GoogleCard state={googleCardState(configured, google, auth.isAnonymous === true)} message={googleMessage} />
        </div>
      </section>

      <section className="stack" aria-labelledby="planned-heading">
        <div className="section-heading">
          <h2 id="planned-heading">Planned accounts</h2>
          <p className="muted">
            Not available yet. These cards preview the plan; none of them can be connected today.
          </p>
        </div>
        <div className="card-grid">
          {PLANNED.map((connector) => (
            <article key={connector.name} className="panel">
              <div className="panel-heading">
                <h3>
                  <span className={`chip chip-${connector.key}`}>{connector.name}</span>
                </h3>
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
      </section>
    </main>
  );
}
