import "server-only";
import type { CatalogTool, McpServer } from "./catalog";

// Tool pins (decision 0016). At Connect, P-Dot stores a hash of the name and
// the input schema of each catalog tool. Before a call, the live definition
// must give the same hash. The definition itself is never stored and never
// goes to the model.

export interface RemoteTool {
  name: string;
  inputSchema: unknown;
}

/** JSON with the keys of every object sorted, so key order does not change the hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export async function pinOf(tool: RemoteTool): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ name: tool.name, inputSchema: tool.inputSchema }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * True when the remote tool takes every argument P-Dot sends, and needs no
 * argument that P-Dot does not send.
 */
export function isCompatible(tool: RemoteTool, local: CatalogTool): boolean {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== "object") return false;
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return false;
  if (!local.sends.every((name) => Object.hasOwn(properties, name))) return false;
  const required = (schema as { required?: unknown }).required;
  if (required === undefined) return true;
  return Array.isArray(required) && required.every((name) => typeof name === "string" && local.sends.includes(name));
}

/** Pins for the catalog tools that the server has in a compatible form. Keyed by the remote name. */
export async function pinTools(server: McpServer, tools: readonly RemoteTool[]): Promise<Record<string, string>> {
  const pins: Record<string, string> = {};
  for (const local of server.tools) {
    const remote = tools.find((tool) => tool.name === local.remote);
    if (remote && isCompatible(remote, local)) pins[local.remote] = await pinOf(remote);
  }
  return pins;
}
