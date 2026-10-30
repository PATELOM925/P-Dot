import type { Metadata } from "next";
import { ChatWorkspace, type GoogleChatState } from "@/features/chat/ChatWorkspace";
import { getAuthContext } from "@/server/auth/session";
import { getGoogleConfig } from "@/server/config";
import { createConnectedAccountRepository } from "@/server/db/connected-accounts";
import { getMode } from "@/server/mode";

export const metadata: Metadata = { title: "Chat · P-Dot" };

interface ChatPageProps {
  searchParams: Promise<{ c?: string | string[] }>;
}

/** What the "Use Google" item shows. The server checks every flag again on each message (decision 0014). */
async function googleState(): Promise<GoogleChatState> {
  if (getGoogleConfig().status !== "ready") return null;
  const auth = await getAuthContext();
  if (!auth) return null;
  if (auth.isAnonymous) return "trial";
  try {
    const connection = await createConnectedAccountRepository(auth.supabase).getGoogleConnection(auth.userId);
    return connection?.status === "connected" ? "connected" : "not_connected";
  } catch {
    return "not_connected";
  }
}

export default async function ChatPage({ searchParams }: ChatPageProps) {
  const { c } = await searchParams;
  const mode = await getMode();
  const google = await googleState();
  // Keyed by mode so switching Personal/Work starts a fresh workspace for that side.
  return <ChatWorkspace key={mode} mode={mode} google={google} initialConversationId={typeof c === "string" ? c : null} />;
}
