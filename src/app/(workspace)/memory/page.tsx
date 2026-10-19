import type { Metadata } from "next";
import Link from "next/link";
import { DocumentsPanel } from "@/features/documents/DocumentsPanel";
import { MemoryList } from "@/features/memory/MemoryList";
import { DOCUMENT_LIST_LIMIT, MEMORY_LIST_LIMIT } from "@/lib/limits";
import { MODE_LABELS } from "@/lib/mode";
import { requireAuth } from "@/server/auth/session";
import { createDocumentRepository } from "@/server/db/documents";
import { createMemoryRepository } from "@/server/db/memories";
import { getMode } from "@/server/mode";

export const metadata: Metadata = { title: "What P-Dot remembers · P-Dot" };

export default async function MemoryPage() {
  const auth = await requireAuth("/memory");
  const mode = await getMode();
  const [memories, documents] = await Promise.all([
    createMemoryRepository(auth.supabase).listMemories(auth.userId, mode, undefined, MEMORY_LIST_LIMIT),
    createDocumentRepository(auth.supabase).listDocuments(auth.userId, mode, DOCUMENT_LIST_LIMIT),
  ]);

  return (
    <main className="page stack">
      <div>
        <h1>What P-Dot remembers</h1>
        <p className="muted">
          Everything P-Dot keeps about you in {MODE_LABELS[mode]} mode: memories and documents. You can change or delete
          any of it, and it only keeps what you add or approve. Switch mode at the top to see the other list.
        </p>
      </div>

      <p className="alert alert-warning" role="status">
        P-Dot does not use these memories or documents in its replies yet; that step is still being built. When it does,
        the &ldquo;What was sent&rdquo; link under each reply will list the ones it used.
      </p>

      <MemoryList key={mode} mode={mode} initialMemories={memories} />

      <DocumentsPanel key={`documents-${mode}`} mode={mode} initialDocuments={documents} />

      <p className="hint">
        Changes to your memories and documents are recorded in the <Link href="/action-log">action log</Link>, without
        their text.
      </p>
    </main>
  );
}
