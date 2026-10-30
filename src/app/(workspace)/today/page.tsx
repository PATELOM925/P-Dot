import type { Metadata } from "next";
import Link from "next/link";
import { ApprovalList } from "@/features/actions/ApprovalList";
import { BriefCard } from "@/features/today/BriefCard";
import { TaskList } from "@/features/today/TaskList";
import { MODE_LABELS } from "@/lib/mode";
import { ACTION_LIST_LIMIT, BRIEF_MAX_TOPICS, TASK_LIST_LIMIT } from "@/lib/limits";
import { requireAuth } from "@/server/auth/session";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { createMemoryRepository } from "@/server/db/memories";
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
  const [tasks, proposals, memories] = await Promise.all([
    createTaskRepository(auth.supabase).listTasks(auth.userId, mode, TASK_LIST_LIMIT),
    createActionProposalRepository(auth.supabase).listProposals(auth.userId, undefined, ACTION_LIST_LIMIT),
    // Topics for an empty brief field. The brief still works when this read fails.
    createMemoryRepository(auth.supabase)
      .listMemories(auth.userId, mode, "active", BRIEF_MAX_TOPICS)
      .catch(() => []),
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
          <BriefCard key={mode} mode={mode} memoryTopics={memories.map((memory) => memory.content)} />

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
