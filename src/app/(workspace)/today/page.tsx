import type { Metadata } from "next";
import Link from "next/link";
import { ApprovalList } from "@/features/actions/ApprovalList";
import { nameFromEmail } from "@/lib/greeting";
import { BriefCard } from "@/features/today/BriefCard";
import { Overview } from "@/features/today/Overview";
import { LayoutControls } from "@/features/today/LayoutControls";
import { TaskList } from "@/features/today/TaskList";
import { TodayBoard } from "@/features/today/TodayBoard";
import { RecentChats, UpNext } from "@/features/today/TodayLists";
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
        <div className="page-actions">
          <LayoutControls userId={auth.userId} />
          <Link className="button button-primary" href="/chat">
            Ask P-Dot
          </Link>
        </div>
      </div>

      <Overview
        mode={mode}
        name={auth.isAnonymous ? null : nameFromEmail(auth.email)}
        tasks={tasks}
        reminders={reminders}
        memories={memories}
        proposals={proposals}
      />

      <TodayBoard
        userId={auth.userId}
        sections={[
          { id: "up-next", title: "Up next", node: <UpNext reminders={reminders} /> },
          { id: "recent-chats", title: "Recent chats", node: <RecentChats conversations={conversations} /> },
          {
            id: "brief",
            title: "Morning brief",
            node: (
              <BriefCard
                key={`brief-${mode}`}
                mode={mode}
                memoryTopics={memories.slice(0, BRIEF_MAX_TOPICS).map((memory) => memory.content)}
              />
            ),
          },
          { id: "approvals", title: "Waiting for your approval", node: <ApprovalList key={mode} mode={mode} initial={proposals} /> },
          {
            id: "tasks",
            title: mode === "work" ? "Work to-do list" : "To-do list",
            node: <TaskList key={mode} mode={mode} initialTasks={tasks} />,
          },
          { id: "workflows", title: "Workflows", node: <WorkflowsSection auth={auth} mode={mode} /> },
        ]}
      />
    </main>
  );
}
