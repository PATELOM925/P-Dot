import type { Metadata } from "next";
import Link from "next/link";
import { ApprovalList } from "@/features/actions/ApprovalList";
import { TaskList } from "@/features/today/TaskList";
import { MODE_LABELS } from "@/lib/mode";
import { ACTION_LIST_LIMIT, TASK_LIST_LIMIT } from "@/lib/limits";
import { requireAuth } from "@/server/auth/session";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { createTaskRepository } from "@/server/db/tasks";
import { getMode } from "@/server/mode";

export const metadata: Metadata = { title: "Today · P-Dot" };

const SCOPE: Record<"personal" | "work", string> = {
  personal: "family, meals, gifts, errands and everyday choices. Work topics stay in Work mode.",
  work: "meetings, email, code, tasks and deadlines only. Personal topics stay in Personal mode.",
};

export default async function TodayPage() {
  const auth = await requireAuth("/today");
  const mode = await getMode();
  const [tasks, proposals] = await Promise.all([
    createTaskRepository(auth.supabase).listTasks(auth.userId, mode, TASK_LIST_LIMIT),
    createActionProposalRepository(auth.supabase).listProposals(auth.userId, undefined, ACTION_LIST_LIMIT),
  ]);

  return (
    <main className="page page-wide stack">
      <div className="page-title">
        <h1>{mode === "work" ? "Your workday" : "Your day"}</h1>
        <Link className="button button-primary" href="/chat">
          Ask P-Dot
        </Link>
      </div>

      <p className={`scope-note scope-note-${mode}`}>
        <strong>{MODE_LABELS[mode]} mode:</strong> {SCOPE[mode]}
      </p>

      <div className="two-column">
        <div className="stack">
          <section className="panel" aria-labelledby="brief-heading">
            <h2 id="brief-heading">Daily brief</h2>
            <p className="muted">
              P-Dot does not make a daily brief yet. To ask about your email and calendar now, connect Google, then
              turn on &ldquo;Use Google&rdquo; in chat.
            </p>
            <Link href="/connectors">Open Connectors</Link>
          </section>

          <TaskList key={mode} mode={mode} initialTasks={tasks} />
        </div>

        <aside className="stack">
          <ApprovalList key={mode} mode={mode} initial={proposals} />
          <section className="panel" aria-labelledby="start-heading">
            <h2 id="start-heading">Start something</h2>
            <p className="muted">
              {mode === "work"
                ? "Draft an update, plan your week, or work through a problem."
                : "Plan dinner, shortlist a gift, or sort out the weekend."}
            </p>
            <Link className="button" href="/chat">
              Open chat
            </Link>
          </section>
        </aside>
      </div>
    </main>
  );
}
