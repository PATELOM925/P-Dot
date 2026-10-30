import "server-only";
import { z } from "zod";
import { openText, sealText } from "@/server/google/crypto";
import { MCP_SERVER_IDS, type McpServerId } from "./catalog";

// The Connect flow's state for an MCP app, sealed in a short-lived httpOnly
// cookie that only the MCP routes receive (decision 0016). The callback takes
// the app, the issuer, the endpoints and the client ID only from here.

export const MCP_STATE_COOKIE = "pdot_mcp_oauth";
export const MCP_STATE_PATH = "/api/connectors/mcp";
export const MCP_STATE_MAX_AGE_SECONDS = 600;
const ASSOCIATED_DATA = "pdot:oauth_state:mcp";
const MAX_COOKIE_CHARS = 3800;

const stateSchema = z
  .object({
    userId: z.string().min(1).max(64),
    server: z.enum(MCP_SERVER_IDS),
    state: z.string().min(32).max(128),
    verifier: z.string().min(43).max(128),
    subject: z.string().regex(/^conn_[0-9a-f-]{36}$/),
    issuer: z.string().max(512),
    tokenEndpoint: z.string().max(512),
    revocationEndpoint: z.string().max(512).nullable(),
    clientId: z.string().min(1).max(512),
    issRequired: z.boolean(),
    expiresAt: z.number().int(),
  })
  .strict();

export type McpOAuthState = z.infer<typeof stateSchema> & { server: McpServerId };

export async function sealMcpState(key: Uint8Array, value: McpOAuthState): Promise<string> {
  const sealed = await sealText(key, JSON.stringify(stateSchema.parse(value)), ASSOCIATED_DATA);
  if (sealed.length > MAX_COOKIE_CHARS) throw new Error("state_too_large");
  return sealed;
}

/** The state, or null when the cookie does not open, does not parse or has expired. */
export async function openMcpState(key: Uint8Array, cookie: string, now: number): Promise<McpOAuthState | null> {
  if (cookie.length > MAX_COOKIE_CHARS) return null;
  const text = await openText(key, cookie, ASSOCIATED_DATA);
  if (text === null) return null;
  try {
    const parsed = stateSchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.expiresAt > now ? parsed.data : null;
  } catch {
    return null;
  }
}
