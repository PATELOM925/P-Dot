import type { Metadata } from "next";
import { ChatWorkspace } from "@/features/chat/ChatWorkspace";
import type { GoogleChatState } from "@/features/chat/composer-sources";
import { hasAccount } from "@/lib/auth-identity";
import type { McpServerId } from "@/lib/connectors";
import { requireAuth, type AuthContext } from "@/server/auth/session";
import { getGoogleConfig, getMcpConfig } from "@/server/config";
import { createConnectedAccountRepository, createMcpAccountRepository } from "@/server/db/connected-accounts";
import { listConnections, usableApps } from "@/server/mcp/health";
import { getMode } from "@/server/mode";

export const metadata: Metadata = { title: "Chat · P-Dot" };

interface ChatPageProps {
  searchParams: Promise<{ c?: string | string[] }>;
}

/** What the "Use Google" item shows. The server checks every flag again on each message (decision 0014). */
async function googleState(auth: AuthContext): Promise<GoogleChatState> {
  if (getGoogleConfig().status !== "ready") return null;
  if (!hasAccount(auth)) return "trial";
  try {
    const connection = await createConnectedAccountRepository(auth.supabase).getGoogleConnection(auth.userId);
    return connection?.status === "connected" ? "connected" : "not_connected";
  } catch {
    return "not_connected";
  }
}

/** The apps the "+" menu offers. A trial user has none. A failure offers none, so chat still works. */
async function loadConnectedApps(auth: AuthContext): Promise<McpServerId[]> {
  const config = getMcpConfig();
  if (config.status !== "ready" || auth.isAnonymous) return [];
  try {
    return usableApps(await listConnections(createMcpAccountRepository(auth.supabase), config.encryptionKey, auth.userId));
  } catch {
    return [];
  }
}

export default async function ChatPage({ searchParams }: ChatPageProps) {
  const { c } = await searchParams;
  const [auth, mode] = await Promise.all([requireAuth("/chat"), getMode()]);
  const [connectedApps, google] = await Promise.all([loadConnectedApps(auth), googleState(auth)]);
  // Keyed by mode so switching Personal/Work starts a fresh workspace for that side.
  return (
    <ChatWorkspace
      key={mode}
      userId={auth.userId}
      mode={mode}
      trial={auth.isAnonymous === true}
      google={google}
      initialConversationId={typeof c === "string" ? c : null}
      connectedApps={connectedApps}
    />
  );
}
