import type { Metadata } from "next";
import Link from "next/link";
import { TaskList } from "@/features/today/TaskList";
import { MODE_LABELS } from "@/lib/mode";
import { TASK_LIST_LIMIT } from "@/lib/limits";
import { requireAuth } from "@/server/auth/session";
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
  const tasks = await createTaskRepository(auth.supabase).listTasks(auth.userId, mode, TASK_LIST_LIMIT);

  return (
    <main className="page page-wide stack">
      <div className="page-title">
        <h1>{mode === "work" ? "Your workday" : "Your day"}</h1>
        <Link className="button button-primary" href="/chat">
          Ask P-Dot
        </Link>
      </div>

      <p className="scope-note">
        <strong>{MODE_LABELS[mode]} mode:</strong> {SCOPE[mode]}
      </p>

      <div className="two-column">
        <div className="stack">
          <section className="panel" aria-labelledby="brief-heading">
            <h2 id="brief-heading">Daily brief</h2>
            <p className="muted">
              No brief yet. A daily brief is built from your email and calendar, and connectors are not available yet.
            </p>
            <Link href="/connectors">See planned connectors</Link>
          </section>

          <TaskList key={mode} mode={mode} initialTasks={tasks} />
        </div>

        <aside className="stack">
          <section className="panel" aria-labelledby="approval-heading">
            <h2 id="approval-heading">Waiting for your approval</h2>
            <p className="muted">
              Nothing is waiting. When automations arrive, anything that sends, books or deletes will show up here
              first.
            </p>
          </section>
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
