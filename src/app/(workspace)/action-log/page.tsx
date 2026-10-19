import type { Metadata } from "next";
import { ActionLogList } from "@/features/actions/ActionLogList";
import { ACTION_LOG_LIMIT } from "@/lib/limits";
import { requireAuth } from "@/server/auth/session";
import { createActionLogRepository } from "@/server/db/action-log";

export const metadata: Metadata = { title: "Action log · P-Dot" };

export default async function ActionLogPage() {
  const auth = await requireAuth("/action-log");
  const entries = await createActionLogRepository(auth.supabase).list(auth.userId, ACTION_LOG_LIMIT);

  return (
    <main className="page stack">
      <div>
        <h1>Action log</h1>
        <p className="muted">
          A record of what P-Dot proposed, what you approved or cancelled, what ran, and every change to your memories,
          documents and reminders. It covers both modes. Entries cannot be edited or deleted.
        </p>
      </div>

      <ActionLogList initialEntries={entries} limit={ACTION_LOG_LIMIT} />

      <p className="hint">
        The log keeps kinds, counts and IDs only, never the text of your messages, tasks, memories or documents. To-do
        items you add or tick off yourself on the Today page are not logged.
      </p>
    </main>
  );
}
