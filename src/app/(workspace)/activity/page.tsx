import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { ActionLogList } from "@/features/actions/ActionLogList";
import { PrivateSourceActivityList } from "@/features/actions/PrivateSourceActivityList";
import { ACTION_LOG_LIMIT } from "@/lib/limits";
import { requireAuth } from "@/server/auth/session";
import { createActionLogRepository } from "@/server/db/action-log";
import { listPrivateSourceActivity } from "@/server/db/activity-policy";

export const metadata: Metadata = { title: "Activity · P-Dot" };

export default async function ActivityPage() {
  const auth = await requireAuth("/activity");
  const [entries, policyEntries] = await Promise.all([
    createActionLogRepository(auth.supabase).list(auth.userId, ACTION_LOG_LIMIT),
    listPrivateSourceActivity(auth.supabase, auth.userId, ACTION_LOG_LIMIT),
  ]);

  return (
    <main className="page stack">
      <PageHeader
        title="Activity"
        info={
          <>
            <p>
              What P-Dot proposed, what you approved or cancelled, what ran, and each change to your memories, documents
              and reminders. It shows both modes. You cannot edit or delete an entry.
            </p>
            <p>
              Action entries keep kinds, counts and IDs only, never the text of your messages, tasks, memories or documents.
              To-do items that you add or tick off on the Today page are not recorded.
            </p>
            <p>Connected-source entries record successful private reads and assistant web searches refused by policy. They are conversation-history metadata, removed with the conversation, and are not protected audit records. Action history remains separate.</p>
          </>
        }
      />

      <ActionLogList initialEntries={entries} limit={ACTION_LOG_LIMIT} />
      <PrivateSourceActivityList initialEntries={policyEntries} />
    </main>
  );
}
