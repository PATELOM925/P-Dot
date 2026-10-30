import type { Metadata } from "next";
import { ChatWorkspace } from "@/features/chat/ChatWorkspace";
import type { McpServerId } from "@/lib/connectors";
import { getAuthContext } from "@/server/auth/session";
import { getMcpConfig } from "@/server/config";
import { createMcpAccountRepository } from "@/server/db/connected-accounts";
import { listConnections, usableApps } from "@/server/mcp/health";
import { getMode } from "@/server/mode";

export const metadata: Metadata = { title: "Chat · P-Dot" };

interface ChatPageProps {
  searchParams: Promise<{ c?: string | string[] }>;
}

/** The apps the "+" menu offers. A failure offers none, so chat still works. */
async function loadConnectedApps(): Promise<McpServerId[]> {
  const config = getMcpConfig();
  if (config.status !== "ready") return [];
  try {
    const auth = await getAuthContext();
    if (!auth || auth.isAnonymous) return [];
    return usableApps(await listConnections(createMcpAccountRepository(auth.supabase), config.encryptionKey, auth.userId));
  } catch {
    return [];
  }
}

export default async function ChatPage({ searchParams }: ChatPageProps) {
  const { c } = await searchParams;
  const [mode, connectedApps] = await Promise.all([getMode(), loadConnectedApps()]);
  // Keyed by mode so switching Personal/Work starts a fresh workspace for that side.
  return (
    <ChatWorkspace
      key={mode}
      mode={mode}
      initialConversationId={typeof c === "string" ? c : null}
      connectedApps={connectedApps}
    />
  );
}
