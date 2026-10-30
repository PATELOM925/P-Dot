import type { Metadata } from "next";
import { ChatWorkspace } from "@/features/chat/ChatWorkspace";
import { requireAuth } from "@/server/auth/session";
import { getMode } from "@/server/mode";

export const metadata: Metadata = { title: "Chat · P-Dot" };

interface ChatPageProps {
  searchParams: Promise<{ c?: string | string[] }>;
}

export default async function ChatPage({ searchParams }: ChatPageProps) {
  const { c } = await searchParams;
  const [auth, mode] = await Promise.all([requireAuth("/chat"), getMode()]);
  // Keyed by mode so switching Personal/Work starts a fresh workspace for that side.
  return (
    <ChatWorkspace
      key={mode}
      mode={mode}
      trial={auth.isAnonymous === true}
      initialConversationId={typeof c === "string" ? c : null}
    />
  );
}
