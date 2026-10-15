import type { Metadata } from "next";
import { ChatWorkspace } from "@/features/chat/ChatWorkspace";

export const metadata: Metadata = { title: "Chat · P-Dot" };

interface ChatPageProps {
  searchParams: Promise<{ c?: string | string[] }>;
}

export default async function ChatPage({ searchParams }: ChatPageProps) {
  const { c } = await searchParams;
  return <ChatWorkspace initialConversationId={typeof c === "string" ? c : null} />;
}
