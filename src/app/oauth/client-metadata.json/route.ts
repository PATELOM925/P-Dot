import { getSiteUrl } from "@/server/config";
import { clientMetadata } from "@/server/mcp/oauth";

/**
 * GET /oauth/client-metadata.json. P-Dot's OAuth Client ID Metadata Document
 * (decision 0016). Its URL is the client ID that MCP apps fetch. Public.
 */
export function GET(): Response {
  return Response.json(clientMetadata(getSiteUrl()), { headers: { "Cache-Control": "public, max-age=3600" } });
}
