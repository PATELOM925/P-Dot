import type { Metadata } from "next";
import { ChatWorkspace } from "@/features/chat/ChatWorkspace";
import type { GoogleChatState } from "@/features/chat/composer-sources";
import { hasAccount } from "@/lib/auth-identity";
import { MAX_MESSAGE_CHARS } from "@/lib/limits";
import type { McpServerId } from "@/lib/connectors";
import { requireAuth, type AuthContext } from "@/server/auth/session";
import { getGoogleConfig, getMcpConfig, getTelegramConfig, isMcpServerReady } from "@/server/config";
import { createConnectedAccountRepository, createMcpAccountRepository } from "@/server/db/connected-accounts";
import { createTelegramLinkRepository } from "@/server/db/telegram-links";
import { listConnections, usableApps } from "@/server/mcp/health";
import { getMode } from "@/server/mode";
import { telegramLinkState } from "@/server/telegram/view";

export const metadata: Metadata = { title: "Chat · P-Dot" };

interface ChatPageProps {
  searchParams: Promise<{ c?: string | string[]; ask?: string | string[] }>;
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
    const apps = usableApps(await listConnections(createMcpAccountRepository(auth.supabase), config.encryptionKey, auth.userId));
    return apps.filter((app) => isMcpServerReady(app));
  } catch {
    return [];
  }
}

/** The linked Telegram chat for "Send to Telegram" (decision 0020). Null when off, not linked or on any failure. */
async function loadTelegram(auth: AuthContext): Promise<{ name: string } | null> {
  const config = getTelegramConfig();
  if (config.status !== "ready" || !hasAccount(auth)) return null;
  try {
    const state = await telegramLinkState(createTelegramLinkRepository(auth.supabase), config.config.sealKey, auth.userId);
    return state.kind === "linked" ? { name: state.name } : null;
  } catch {
    return null;
  }
}

export default async function ChatPage({ searchParams }: ChatPageProps) {
  const { c, ask } = await searchParams;
  const [auth, mode] = await Promise.all([requireAuth("/chat"), getMode()]);
  const [connectedApps, google, telegram] = await Promise.all([loadConnectedApps(auth), googleState(auth), loadTelegram(auth)]);
  // Keyed by mode so switching Personal/Work starts a fresh workspace for that side.
  return (
    <ChatWorkspace
      key={mode}
      userId={auth.userId}
      mode={mode}
      trial={auth.isAnonymous === true}
      google={google}
      initialConversationId={typeof c === "string" ? c : null}
      initialDraft={typeof ask === "string" ? ask.slice(0, MAX_MESSAGE_CHARS) : ""}
      connectedApps={connectedApps}
      telegram={telegram}
    />
  );
}
