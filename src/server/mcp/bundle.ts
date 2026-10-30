import "server-only";
import { z } from "zod";
import { openText, sealText } from "@/server/google/crypto";
import { MCP_SERVER_IDS, type McpServer, type McpServerId } from "./catalog";

// The sealed token bundle of one MCP connection (decision 0016). It is stored
// in connected_accounts.token_ciphertext. The associated data binds it to the
// user, the app and the connection subject, which is new at every Connect, so
// a copied or stale ciphertext does not open for another connection.

/** The database allows 12,288 characters for an MCP ciphertext. */
export const MAX_SEALED_CHARS = 12_288;

const pins = z.record(z.string().min(1).max(128), z.string().regex(/^[0-9a-f]{64}$/));

const bundleSchema = z
  .object({
    v: z.literal(1),
    server: z.enum(MCP_SERVER_IDS),
    issuer: z.string().max(512),
    resource: z.string().max(512),
    clientId: z.string().min(1).max(512),
    tokenEndpoint: z.string().max(512),
    revocationEndpoint: z.string().max(512).nullable(),
    accessToken: z.string().min(1).max(4096),
    accessExpiresAt: z.number().int(),
    refreshToken: z.string().min(1).max(2048).nullable(),
    pins,
    claim: z.object({ id: z.string().uuid(), until: z.number().int() }).strict().nullable(),
  })
  .strict();

export type McpBundle = z.infer<typeof bundleSchema>;

export const bundleAssociatedData = (userId: string, server: McpServerId, subject: string) =>
  `pdot:connected_accounts:${userId}:${server}:${subject}`;

export function sealBundle(key: Uint8Array, userId: string, subject: string, bundle: McpBundle): Promise<string> {
  return sealText(key, JSON.stringify(bundleSchema.parse(bundle)), bundleAssociatedData(userId, bundle.server, subject));
}

/**
 * The bundle, or null when it does not open, does not parse, or does not
 * match the catalog entry (another issuer, resource or token endpoint origin).
 */
export async function openBundle(
  key: Uint8Array,
  userId: string,
  server: McpServer,
  subject: string,
  sealed: string,
): Promise<McpBundle | null> {
  if (sealed.length > MAX_SEALED_CHARS) return null;
  const text = await openText(key, sealed, bundleAssociatedData(userId, server.id, subject));
  if (text === null) return null;
  try {
    const parsed = bundleSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    const bundle = parsed.data;
    if (bundle.server !== server.id || bundle.issuer !== server.issuer || bundle.resource !== server.resource) return null;
    if (!server.authOrigins.includes(new URL(bundle.tokenEndpoint).origin)) return null;
    return bundle;
  } catch {
    return null;
  }
}
