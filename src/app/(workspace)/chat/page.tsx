import type { Metadata } from "next";
import { ChatWorkspace, type GoogleChatState } from "@/features/chat/ChatWorkspace";
import { hasAccount } from "@/lib/auth-identity";
import type { McpServerId } from "@/lib/connectors";
import { getAuthContext, type AuthContext } from "@/server/auth/session";
import { getGoogleConfig, getMcpConfig } from "@/server/config";
import { createConnectedAccountRepository, createMcpAccountRepository } from "@/server/db/connected-accounts";
import { listConnections, usableApps } from "@/server/mcp/health";
import { getMode } from "@/server/mode";

export const metadata: Metadata = { title: "Chat · P-Dot" };

interface ChatPageProps {
  searchParams: Promise<{ c?: string | string[] }>;
}

/** What the "Use Google" item shows. The server checks every flag again on each message (decision 0014). */
async function googleState(auth: AuthContext | null): Promise<GoogleChatState> {
  if (getGoogleConfig().status !== "ready" || !auth) return null;
  if (!hasAccount(auth)) return "trial";
  try {
    const connection = await createConnectedAccountRepository(auth.supabase).getGoogleConnection(auth.userId);
    return connection?.status === "connected" ? "connected" : "not_connected";
  } catch {
    return "not_connected";
  }
}

/** The apps the "+" menu offers. A failure offers none, so chat still works. */
async function loadConnectedApps(auth: AuthContext | null): Promise<McpServerId[]> {
  const config = getMcpConfig();
  if (config.status !== "ready") return [];
  try {
    if (!auth || auth.isAnonymous) return [];
    return usableApps(await listConnections(createMcpAccountRepository(auth.supabase), config.encryptionKey, auth.userId));
  } catch {
    return [];
  }
}

export default async function ChatPage({ searchParams }: ChatPageProps) {
  const { c } = await searchParams;
  const auth = await getAuthContext();
  const [mode, connectedApps, google] = await Promise.all([getMode(), loadConnectedApps(auth), googleState(auth)]);
  // Keyed by mode so switching Personal/Work starts a fresh workspace for that side.
  return (
    <ChatWorkspace
      key={mode}
      mode={mode}
      google={google}
      initialConversationId={typeof c === "string" ? c : null}
      connectedApps={connectedApps}
    />
  );
}
