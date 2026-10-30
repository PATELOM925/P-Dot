import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { DocumentsPanel } from "@/features/documents/DocumentsPanel";
import { MemoryList } from "@/features/memory/MemoryList";
import { DOCUMENT_LIST_LIMIT, MEMORY_LIST_LIMIT } from "@/lib/limits";
import { MODE_LABELS } from "@/lib/mode";
import { requireAuth } from "@/server/auth/session";
import { createDocumentRepository } from "@/server/db/documents";
import { createMemoryRepository } from "@/server/db/memories";
import { getMode } from "@/server/mode";

export const metadata: Metadata = { title: "Memory · P-Dot" };

export default async function MemoryPage() {
  const auth = await requireAuth("/memory");
  const mode = await getMode();
  const [memories, documents] = await Promise.all([
    createMemoryRepository(auth.supabase).listMemories(auth.userId, mode, undefined, MEMORY_LIST_LIMIT),
    createDocumentRepository(auth.supabase).listDocuments(auth.userId, mode, DOCUMENT_LIST_LIMIT),
  ]);

  return (
    <main className="page stack">
      <PageHeader
        title="Memory"
        info={
          <>
            <p>
              This page shows what P-Dot keeps for {MODE_LABELS[mode]} mode. It keeps only what you add or approve, and
              you can change or delete all of it. Switch the mode at the top to see the other list.
            </p>
            <p>
              P-Dot uses your kept memories when it replies. It searches your documents when you ask about your notes,
              documents or files. It does not use a suggested memory until you keep it. Open &ldquo;What was sent&rdquo;
              under a reply to see which ones it used.
            </p>
            <p>
              Changes to your memories and documents show in <Link href="/activity">Activity</Link>, without their text.
            </p>
          </>
        }
      />

      <MemoryList key={mode} mode={mode} initialMemories={memories} />

      <DocumentsPanel key={`documents-${mode}`} mode={mode} initialDocuments={documents} />
    </main>
  );
}
