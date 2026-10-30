import { describe, expect, it } from "vitest";
import { MCP_SERVERS } from "@/server/mcp/catalog";
import { OAuthError, clientIdFor, discover, exchangeCode, refreshTokens, resourceMetadataUrl, revokeToken, serverMetadataUrl } from "@/server/mcp/oauth";
import { fakeApp } from "../support/fake-mcp";

const notion = MCP_SERVERS.notion;
const todoist = MCP_SERVERS.todoist;

describe("MCP OAuth", () => {
  it("builds the RFC 9728 and RFC 8414 metadata URLs", () => {
    expect(resourceMetadataUrl("https://mcp.notion.com/mcp")).toBe("https://mcp.notion.com/.well-known/oauth-protected-resource/mcp");
    expect(serverMetadataUrl("https://todoist.com")).toBe("https://todoist.com/.well-known/oauth-authorization-server");
  });

  it("discovers endpoints on the catalog's origins, with the iss and CIMD flags", async () => {
    const app = fakeApp("todoist", { issParameter: false });
    const endpoints = await discover(app.fetch, todoist);
    expect(endpoints).toMatchObject({ issuer: "https://todoist.com", tokenEndpoint: "https://todoist.com/token", issRequired: false, cimd: true });
  });

  it("refuses a resource that is not the catalog's", async () => {
    const app = fakeApp("notion");
    const wrong = async (url: string, init?: RequestInit) =>
      url.includes("oauth-protected-resource")
        ? Response.json({ resource: "https://evil.example/mcp", authorization_servers: [notion.issuer] })
        : app.fetch(url, init);
    await expect(discover(wrong, notion)).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("uses CIMD only on an https site, else registers", async () => {
    const app = fakeApp("notion");
    const endpoints = await discover(app.fetch, notion);
    expect(await clientIdFor(app.fetch, endpoints, "https://pdot.example")).toBe("https://pdot.example/oauth/client-metadata.json");
    expect(await clientIdFor(app.fetch, endpoints, "http://localhost:3000")).toBe("registered-client");
    await expect(clientIdFor(app.fetch, { ...endpoints, cimd: false, registrationEndpoint: null }, "https://pdot.example")).rejects.toBeInstanceOf(
      OAuthError,
    );
  });

  it("sends resource on the code exchange and the refresh, defaults a missing expiry, and keeps only accepted scopes", async () => {
    const app = fakeApp("notion", { expiresIn: null });
    const tokens = await exchangeCode(
      app.fetch,
      notion,
      { tokenEndpoint: "https://mcp.notion.com/token", clientId: "c", redirectUri: "https://pdot.example/cb", code: "good-code", verifier: "v".repeat(43) },
      1_000,
    );
    expect(tokens.accessExpiresAt).toBe(1_000 + 3_600_000);
    expect(tokens.scopes).toEqual(["default"]);
    const refreshed = await refreshTokens(app.fetch, notion, { tokenEndpoint: "https://mcp.notion.com/token", clientId: "c", refreshToken: tokens.refreshToken! }, 2_000);
    expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);
    const sent = new URLSearchParams(app.calls.at(-1)!.body);
    expect(sent.get("resource")).toBe(notion.resource);
    expect(sent.get("grant_type")).toBe("refresh_token");
    await expect(
      refreshTokens(app.fetch, notion, { tokenEndpoint: "https://mcp.notion.com/token", clientId: "c", refreshToken: tokens.refreshToken! }, 3_000),
    ).rejects.toMatchObject({ label: "invalid_grant" });
  });

  it("reports a revoke as confirmed only for a 2xx answer", async () => {
    const ok = async () => new Response(null, { status: 200 });
    const down = async () => new Response(null, { status: 503 });
    const input = { revocationEndpoint: "https://mcp.notion.com/revoke", clientId: "c", token: "t", hint: "refresh_token" as const };
    expect(await revokeToken(ok, input)).toBe(true);
    expect(await revokeToken(down, input)).toBe(false);
  });
});
