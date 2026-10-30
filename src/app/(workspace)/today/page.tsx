import type { Metadata } from "next";
import Link from "next/link";
import { ApprovalList } from "@/features/actions/ApprovalList";
import { nameFromEmail } from "@/lib/greeting";
import { BriefCard } from "@/features/today/BriefCard";
import { Overview } from "@/features/today/Overview";
import { TaskList } from "@/features/today/TaskList";
import { MODE_LABELS } from "@/lib/mode";
import { ACTION_LIST_LIMIT, BRIEF_MAX_TOPICS, MEMORY_LIST_LIMIT, REMINDER_LIST_LIMIT, TASK_LIST_LIMIT } from "@/lib/limits";
import { requireAuth } from "@/server/auth/session";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { createConversationRepository } from "@/server/db/conversations";
import { createMemoryRepository } from "@/server/db/memories";
import { createReminderRepository } from "@/server/db/reminders";
import { createTaskRepository } from "@/server/db/tasks";
import { getMode } from "@/server/mode";
import { InfoNote } from "@/components/ui/PageHeader";
import { WorkflowsSection } from "./WorkflowsSection";

export const metadata: Metadata = { title: "Today · P-Dot" };

const SCOPE: Record<"personal" | "work", string> = {
  personal: "family, meals, gifts, errands and everyday choices. Work topics stay in Work mode.",
  work: "meetings, email, code, tasks and deadlines only. Personal topics stay in Personal mode.",
};

export default async function TodayPage() {
  const auth = await requireAuth("/today");
  const mode = await getMode();
  const [tasks, proposals, reminders, memories, conversations] = await Promise.all([
    createTaskRepository(auth.supabase).listTasks(auth.userId, mode, TASK_LIST_LIMIT),
    createActionProposalRepository(auth.supabase).listProposals(auth.userId, undefined, ACTION_LIST_LIMIT),
    createReminderRepository(auth.supabase).listReminders(auth.userId, mode, REMINDER_LIST_LIMIT),
    // The Remembered count and the topics for an empty brief field. The page still works when this read fails.
    createMemoryRepository(auth.supabase)
      .listMemories(auth.userId, mode, "active", MEMORY_LIST_LIMIT)
      .catch(() => []),
    createConversationRepository(auth.supabase).listConversations(auth.userId, 5, mode),
  ]);

  return (
    <main className="page page-wide stack">
      <div className="page-title">
        <div className="page-head">
          <h1>{mode === "work" ? "Your workday" : "Your day"}</h1>
          <InfoNote label="About this page">
            <p>
              <strong>{MODE_LABELS[mode]} mode:</strong> {SCOPE[mode]}
            </p>
          </InfoNote>
        </div>
        <Link className="button button-primary" href="/chat">
          Ask P-Dot
        </Link>
      </div>

      <Overview
        mode={mode}
        name={auth.isAnonymous ? null : nameFromEmail(auth.email)}
        tasks={tasks}
        reminders={reminders}
        memories={memories}
        proposals={proposals}
        conversations={conversations}
      />

      <div className="two-column">
        <div className="stack">
          <BriefCard
            key={`brief-${mode}`}
            mode={mode}
            memoryTopics={memories.slice(0, BRIEF_MAX_TOPICS).map((memory) => memory.content)}
          />

          <TaskList key={mode} mode={mode} initialTasks={tasks} />
        </div>

        <aside className="stack">
          <ApprovalList key={mode} mode={mode} initial={proposals} />
        </aside>
      </div>

      <WorkflowsSection auth={auth} mode={mode} />
    </main>
  );
}
