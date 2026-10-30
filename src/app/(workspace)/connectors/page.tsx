import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { GoogleCard } from "@/features/connectors/GoogleCard";
import { googleCardState, googleOutcomeMessage } from "@/features/connectors/google";
import { connectorLayout } from "@/features/connectors/layout";
import { McpCard } from "@/features/connectors/McpCard";
import { mcpCardState, mcpOutcomeMessage } from "@/features/connectors/mcp";
import { OpenOnPhoneCard } from "@/features/connectors/OpenOnPhoneCard";
import { builtInStatus } from "@/features/connectors/status";
import { TelegramCard, type TelegramCardState } from "@/features/connectors/TelegramCard";
import { telegramOutcomeMessage } from "@/lib/telegram";
import { DOCUMENT_LIST_LIMIT, MEMORY_LIST_LIMIT, REMINDER_LIST_LIMIT, TASK_LIST_LIMIT } from "@/lib/limits";
import { MODE_LABELS } from "@/lib/mode";
import { requireAuth, type AuthContext } from "@/server/auth/session";
import { getGoogleConfig, getMcpConfig, getSiteUrl, getTelegramConfig, isMcpServerReady } from "@/server/config";
import { createConnectedAccountRepository, createMcpAccountRepository } from "@/server/db/connected-accounts";
import { createDocumentRepository } from "@/server/db/documents";
import { createMemoryRepository } from "@/server/db/memories";
import { createReminderRepository } from "@/server/db/reminders";
import { createTaskRepository } from "@/server/db/tasks";
import { createTelegramLinkRepository } from "@/server/db/telegram-links";
import { listConnections, type McpConnectionView } from "@/server/mcp/health";
import { getMode } from "@/server/mode";
import { telegramLinkState } from "@/server/telegram/view";
import type { Mode } from "@/types/api";

export const metadata: Metadata = { title: "Connectors · P-Dot" };

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

/** The MCP app rows without tokens, or "load_failed" for every card. A failure here never breaks the rest of the page. */
async function loadMcpConnections(auth: AuthContext, key: Uint8Array): Promise<McpConnectionView[] | "load_failed"> {
  try {
    return await listConnections(createMcpAccountRepository(auth.supabase), key, auth.userId);
  } catch {
    return "load_failed";
  }
}

/** The Telegram card for a user with an account. A failure here never breaks the rest of the page. */
async function loadTelegramCard(auth: AuthContext, key: Uint8Array): Promise<TelegramCardState> {
  try {
    return await telegramLinkState(createTelegramLinkRepository(auth.supabase), key, auth.userId);
  } catch {
    return { kind: "load_failed" };
  }
}

interface ConnectorsPageProps {
  searchParams: Promise<{ google?: string | string[]; mcp?: string | string[]; app?: string | string[]; telegram?: string | string[] }>;
}

export default async function ConnectorsPage({ searchParams }: ConnectorsPageProps) {
  const auth = await requireAuth("/connectors");
  const mode = await getMode();
  const configured = getGoogleConfig().status === "ready";
  const mcpConfig = getMcpConfig();
  const telegramConfig = getTelegramConfig();
  // A connector without its settings stays under "Coming soon" (decision 0020).
  const layout = connectorLayout({ isAppReady: (app) => isMcpServerReady(app), telegramReady: telegramConfig.status === "ready" });
  const [status, google, mcpViews, telegram] = await Promise.all([
    loadBuiltInStatus(auth, mode),
    configured && !auth.isAnonymous ? loadGoogleConnection(auth) : Promise.resolve(null),
    mcpConfig.status === "ready" && !auth.isAnonymous ? loadMcpConnections(auth, mcpConfig.encryptionKey) : Promise.resolve([]),
    telegramConfig.status !== "ready"
      ? Promise.resolve(null)
      : auth.isAnonymous
        ? Promise.resolve<TelegramCardState>({ kind: "account_required" })
        : loadTelegramCard(auth, telegramConfig.config.sealKey),
  ]);
  const params = await searchParams;
  const googleMessage = googleOutcomeMessage(params.google);
  const mcpMessage = mcpOutcomeMessage(params.mcp, params.app);
  const telegramMessage = telegramOutcomeMessage(params.telegram);

  // P-Dot's own lists and files. The first three are the only things an approved action can change (decision 0009).
  const builtIn = [
    { name: "To-do list", href: "/today", link: "Open your to-do list", status: status.tasks, can: "add a task you approve." },
    { name: "Reminders", href: "/today#workflows", link: "Open your reminders", status: status.reminders, can: "set a reminder you approve." },
    { name: "Memory", href: "/memory", link: "Open what P-Dot remembers", status: status.memory, can: "remember something you approve." },
    {
      name: "Documents",
      href: "/memory#documents",
      link: "Open your documents",
      status: status.documents,
      can: "keep the text of files you add: text, CSV, PDF, Word, images and more. P-Dot can search them when you ask about your notes, documents or files.",
    },
  ];

  return (
    <main className="page page-wide stack">
      <PageHeader
        title="Connectors"
        info={
          <>
            <p>
              You choose what P-Dot can see. It asks before it sends, books, changes or deletes anything. Each decision
              shows in <Link href="/activity">Activity</Link>.
            </p>
            <p>
              Built in: P-Dot&apos;s own lists and files, shown for {MODE_LABELS[mode]} mode. A chat action adds to a
              list only after you approve it on its card.
            </p>
            <p>
              Your accounts: P-Dot reads an account only for one message. A message that names Notion, Linear or Todoist,
              or asks about your email or calendar, turns that account on. You can turn an account on or off in the + menu
              before you send.
            </p>
          </>
        }
      />

      <section className="stack" aria-labelledby="accounts-heading">
        <h2 id="accounts-heading">Your accounts</h2>
        {auth.isAnonymous && (
          <p className="alert alert-notice">
            Create an account to connect other accounts. <Link href="/signup">Create an account</Link>
          </p>
        )}
        <div className="card-grid">
          <GoogleCard state={googleCardState(configured, google, auth.isAnonymous === true)} message={googleMessage} />
          {layout.apps.map((app) => (
            <McpCard
              key={app}
              app={app}
              state={mcpCardState(
                mcpConfig.status === "ready",
                mcpViews === "load_failed" ? "load_failed" : (mcpViews.find((view) => view.server === app) ?? null),
                auth.isAnonymous === true,
              )}
              message={params.app === app ? mcpMessage : null}
            />
          ))}
          {telegram && <TelegramCard state={telegram} message={telegramMessage} />}
        </div>
      </section>

      <section className="stack" aria-labelledby="devices-heading">
        <h2 id="devices-heading">Your devices</h2>
        <div className="card-grid">
          <OpenOnPhoneCard siteUrl={getSiteUrl()} />
        </div>
      </section>

      <section className="stack" aria-labelledby="built-in-heading">
        <h2 id="built-in-heading">Built in</h2>
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
        </div>
      </section>

      <details className="more-details stack">
        <summary>Coming soon ({layout.planned.length + 1})</summary>
        <div className="card-grid">
          {layout.planned.map((connector) => (
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
      </details>
    </main>
  );
}
