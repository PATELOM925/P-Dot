import type { Metadata } from "next";
import { ChatWorkspace } from "@/features/chat/ChatWorkspace";
import type { McpServerId } from "@/lib/connectors";
import { requireAuth, type AuthContext } from "@/server/auth/session";
import { getMcpConfig } from "@/server/config";
import { createMcpAccountRepository } from "@/server/db/connected-accounts";
import { listConnections, usableApps } from "@/server/mcp/health";
import { getMode } from "@/server/mode";

export const metadata: Metadata = { title: "Chat · P-Dot" };

interface ChatPageProps {
  searchParams: Promise<{ c?: string | string[] }>;
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
  const connectedApps = await loadConnectedApps(auth);
  // Keyed by mode so switching Personal/Work starts a fresh workspace for that side.
  return (
    <ChatWorkspace
      key={mode}
      mode={mode}
      trial={auth.isAnonymous === true}
      initialConversationId={typeof c === "string" ? c : null}
      connectedApps={connectedApps}
    />
  );
}
