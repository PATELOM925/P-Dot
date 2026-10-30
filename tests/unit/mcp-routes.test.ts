import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/server/auth/session";
import { FakeMcpAccounts, TEST_KEY, fakeApp, seedConnection, type FakeApp } from "../support/fake-mcp";
import { sweepWriteFaults } from "../support/write-faults";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/db/connected-accounts", () => ({ createMcpAccountRepository: vi.fn() }));
vi.mock("@/server/db/quota", () => ({ createQuotaGate: vi.fn() }));

const { getAuthContext } = await import("@/server/auth/session");
const { createMcpAccountRepository } = await import("@/server/db/connected-accounts");
const { createQuotaGate } = await import("@/server/db/quota");
const connectRoute = await import("@/app/api/connectors/mcp/[server]/connect/route");
const callbackRoute = await import("@/app/api/connectors/mcp/callback/route");
const disconnectRoute = await import("@/app/api/connectors/mcp/[server]/disconnect/route");
const metadataRoute = await import("@/app/oauth/client-metadata.json/route");
const { openBundle } = await import("@/server/mcp/bundle");
const { MCP_SERVERS } = await import("@/server/mcp/catalog");

const USER = "user-1";
const SITE = "https://pdot.example";
const KEY = Buffer.from(TEST_KEY).toString("base64");

let accounts: FakeMcpAccounts;
let quotaCalls: number;
let quotaAllowed: boolean;
let logs: string[];
let app: FakeApp;

class Quota {
  async consume() {
    quotaCalls += 1;
    return { allowed: quotaAllowed, resetsAt: new Date(Date.now() + 60_000) };
  }
}
let quota: Quota;

function signInAs(userId: string | null, isAnonymous = false) {
  vi.mocked(getAuthContext).mockResolvedValue(
    userId ? ({ userId, email: null, isAnonymous, supabase: {} as SupabaseClient } satisfies AuthContext) : null,
  );
}

const post = (path: string) =>
  new Request(`${SITE}${path}`, { method: "POST", headers: { host: "pdot.example", origin: SITE } });
const params = (server: string) => ({ params: Promise.resolve({ server }) });
const outcome = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("mcp");

async function startConnect(server = "notion") {
  const response = await connectRoute.POST(post(`/api/connectors/mcp/${server}/connect`), params(server));
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location")!);
  const cookie = /pdot_mcp_oauth=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  return { location, state: location.searchParams.get("state")!, cookie: cookie!, setCookie: response.headers.get("set-cookie") ?? "" };
}

function callback(query: Record<string, string | string[]>, cookie?: string) {
  const url = new URL(`${SITE}/api/connectors/mcp/callback`);
  for (const [key, value] of Object.entries(query)) for (const item of [value].flat()) url.searchParams.append(key, item);
  return callbackRoute.GET(new NextRequest(url, { headers: { host: "pdot.example", ...(cookie ? { cookie: `pdot_mcp_oauth=${cookie}` } : {}) } }));
}

const cleared = (response: Response) => /pdot_mcp_oauth=;.*Max-Age=0/i.test(response.headers.get("set-cookie") ?? "");

beforeEach(() => {
  accounts = new FakeMcpAccounts();
  quotaCalls = 0;
  quotaAllowed = true;
  quota = new Quota();
  vi.mocked(createMcpAccountRepository).mockImplementation(() => accounts);
  vi.mocked(createQuotaGate).mockImplementation(() => quota);
  vi.stubEnv("SITE_URL", SITE);
  vi.stubEnv("CONNECTOR_TOKEN_ENCRYPTION_KEY", KEY);
  vi.stubEnv("NEBIUS_API_KEY", "test-key");
  app = fakeApp("notion");
  vi.stubGlobal("fetch", app.fetch);
  logs = [];
  for (const method of ["info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
  }
  signInAs(USER);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function expectNoSecretsInLogs() {
  const text = logs.join("\n");
  expect(text).not.toMatch(/access-notion|refresh-notion|good-code/);
  expect(text).not.toContain(KEY);
}

describe("GET /oauth/client-metadata.json", () => {
  it("serves P-Dot's client metadata with its own URL as the client ID", async () => {
    const body = (await metadataRoute.GET().json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      client_id: `${SITE}/oauth/client-metadata.json`,
      client_name: "P-Dot",
      redirect_uris: [`${SITE}/api/connectors/mcp/callback`],
      token_endpoint_auth_method: "none",
    });
  });
});

describe("POST /api/connectors/mcp/:server/connect", () => {
  it("discovers the endpoints, uses CIMD, and sends the browser to consent with PKCE, resource and a sealed cookie", async () => {
    const { location, setCookie } = await startConnect();
    expect(location.origin + location.pathname).toBe("https://mcp.notion.com/authorize");
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      response_type: "code",
      client_id: `${SITE}/oauth/client-metadata.json`,
      redirect_uri: `${SITE}/api/connectors/mcp/callback`,
      scope: "default",
      code_challenge_method: "S256",
      resource: "https://mcp.notion.com/mcp",
    });
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Path=\/api\/connectors\/mcp/);
    expect(setCookie).not.toContain(location.searchParams.get("state")!);
    expect(app.calls.some((call) => call.url.endsWith("/register"))).toBe(false);
    expect(quotaCalls).toBe(1);
  });

  it("registers a client (RFC 7591) when the app does not support CIMD", async () => {
    app = fakeApp("notion", { cimd: false });
    vi.stubGlobal("fetch", app.fetch);
    const { location } = await startConnect();
    expect(location.searchParams.get("client_id")).toBe("registered-client");
    const registration = JSON.parse(app.calls.find((call) => call.url.endsWith("/register"))!.body) as Record<string, unknown>;
    expect(registration).toMatchObject({ token_endpoint_auth_method: "none", application_type: "web" });
  });

  it.each([
    ["another issuer", { issuer: "https://evil.example" }],
    ["a token endpoint on another origin", { token_endpoint: "https://evil.example/token" }],
    ["no S256", { code_challenge_methods_supported: ["plain"] }],
    ["neither CIMD nor DCR", { client_id_metadata_document_supported: false, registration_endpoint: undefined }],
  ])("refuses metadata with %s and sets no cookie", async (_name, metadata) => {
    app = fakeApp("notion", { metadata });
    vi.stubGlobal("fetch", app.fetch);
    const response = await connectRoute.POST(post("/api/connectors/mcp/notion/connect"), params("notion"));
    expect(outcome(response)).toBe("not_supported");
    expect(response.headers.get("set-cookie") ?? "").not.toContain("pdot_mcp_oauth=v1");
  });

  it("refuses an anonymous session, an unknown app, the quota and a missing key before any outside call", async () => {
    signInAs(USER, true);
    const anonymous = await connectRoute.POST(post("/api/connectors/mcp/notion/connect"), params("notion"));
    expect(anonymous.status).toBe(403);
    expect((await anonymous.json()) as { error: { code: string } }).toMatchObject({ error: { code: "account_required" } });
    signInAs(USER);
    expect(outcome(await connectRoute.POST(post("/api/connectors/mcp/github/connect"), params("github")))).toBe("error");
    quotaAllowed = false;
    expect(outcome(await connectRoute.POST(post("/api/connectors/mcp/notion/connect"), params("notion")))).toBe("rate_limited");
    vi.stubEnv("CONNECTOR_TOKEN_ENCRYPTION_KEY", "");
    expect(outcome(await connectRoute.POST(post("/api/connectors/mcp/notion/connect"), params("notion")))).toBe("not_set_up");
    expect(app.calls).toEqual([]);
  });
});

describe("GET /api/connectors/mcp/callback", () => {
  it("exchanges the code with the verifier and resource, pins the tools, seals the bundle and saves once", async () => {
    const { state, cookie } = await startConnect();
    const response = await callback({ code: "good-code", state, iss: "https://mcp.notion.com" }, cookie);
    expect(outcome(response)).toBe("connected");
    expect(cleared(response)).toBe(true);
    const row = (await accounts.getMcp(USER, "notion"))!;
    expect(row).toMatchObject({ provider: "notion", scopes: ["default"], status: "connected" });
    expect(row.subject).toMatch(/^conn_/);
    const bundle = await openBundle(TEST_KEY, USER, MCP_SERVERS.notion, row.subject, row.tokenCiphertext);
    expect(Object.keys(bundle!.pins).sort()).toEqual(["notion-fetch", "notion-search"]);
    expect(row.tokenCiphertext).not.toContain("access-notion");
    expect(JSON.stringify(bundle)).not.toContain("IGNORE ALL RULES");
    const exchange = new URLSearchParams(app.calls.find((call) => call.url.endsWith("/token"))!.body);
    expect(exchange.get("resource")).toBe("https://mcp.notion.com/mcp");
    expect(exchange.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expectNoSecretsInLogs();
  });

  it.each([
    ["a wrong iss", { iss: "https://evil.example" }],
    ["a missing iss when the app sends it", {}],
    ["a repeated code", { iss: "https://mcp.notion.com", code: ["good-code", "good-code"] }],
    ["a repeated state", { iss: "https://mcp.notion.com", extraState: true }],
  ])("refuses %s, stores nothing, calls nothing and clears the cookie", async (_name, extra: Record<string, unknown>) => {
    const { state, cookie } = await startConnect();
    const before = app.calls.length;
    const query: Record<string, string | string[]> = { code: "good-code", state };
    if (typeof extra.iss === "string") query.iss = extra.iss;
    if (Array.isArray(extra.code)) query.code = extra.code as string[];
    if (extra.extraState) query.state = [state, state];
    const response = await callback(query, cookie);
    expect(outcome(response)).toBe("error");
    expect(cleared(response)).toBe(true);
    expect(app.calls.length).toBe(before);
    expect(accounts.rows.size).toBe(0);
  });

  it("refuses a wrong state, another user's cookie, and no cookie", async () => {
    const { state, cookie } = await startConnect();
    expect(outcome(await callback({ code: "good-code", state: `${state}x`, iss: "https://mcp.notion.com" }, cookie))).toBe("error");
    signInAs("user-2");
    expect(outcome(await callback({ code: "good-code", state, iss: "https://mcp.notion.com" }, cookie))).toBe("error");
    expect(outcome(await callback({ code: "good-code", state, iss: "https://mcp.notion.com" }))).toBe("error");
    expect(accounts.rows.size).toBe(0);
  });

  it("refuses an anonymous session and clears the cookie", async () => {
    const { state, cookie } = await startConnect();
    signInAs(USER, true);
    const response = await callback({ code: "good-code", state, iss: "https://mcp.notion.com" }, cookie);
    expect(outcome(response)).toBe("account_required");
    expect(cleared(response)).toBe(true);
    expect(app.calls.filter((call) => call.url.endsWith("/token"))).toEqual([]);
  });

  it("answers denied for access_denied without a token call", async () => {
    const { state, cookie } = await startConnect();
    const response = await callback({ error: "access_denied", state, iss: "https://mcp.notion.com" }, cookie);
    expect(outcome(response)).toBe("denied");
    expect(app.calls.filter((call) => call.url.endsWith("/token"))).toEqual([]);
  });

  it("stores nothing and revokes the new token when the app offers no usable tool", async () => {
    app.setTools([]);
    const { state, cookie } = await startConnect();
    expect(outcome(await callback({ code: "good-code", state, iss: "https://mcp.notion.com" }, cookie))).toBe("no_tools");
    expect(accounts.rows.size).toBe(0);
    expect(app.calls.some((call) => call.url.endsWith("/revoke"))).toBe(true);
  });

  it("checks the save with a write-fault sweep: a refused or lost save answers error, and a new Connect works", async () => {
    await sweepWriteFaults(async (faults) => {
      accounts = new FakeMcpAccounts();
      faults.wrap(accounts, ["saveMcp"], { label: "accounts" });
      app = fakeApp("notion");
      vi.stubGlobal("fetch", app.fetch);
      const first = await startConnect();
      const response = await callback({ code: "good-code", state: first.state, iss: "https://mcp.notion.com" }, first.cookie);
      const failed = faults.fired.length > 0;
      expect(outcome(response)).toBe(failed ? "error" : "connected");
      expect(cleared(response)).toBe(true);
      faults.disarm();
      const again = await startConnect();
      expect(outcome(await callback({ code: "good-code", state: again.state, iss: "https://mcp.notion.com" }, again.cookie))).toBe("connected");
      const rows = await accounts.listMcp(USER);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("connected");
    });
  });
});

describe("POST /api/connectors/mcp/:server/disconnect", () => {
  it("revokes the refresh token and deletes the row it read", async () => {
    const seeded = await seedConnection(accounts, app, "notion", { userId: USER });
    const response = await disconnectRoute.POST(post("/api/connectors/mcp/notion/disconnect"), params("notion"));
    expect(outcome(response)).toBe("disconnected");
    expect(accounts.rows.size).toBe(0);
    const revoke = new URLSearchParams(app.calls.find((call) => call.url.endsWith("/revoke"))!.body);
    expect(revoke.get("token")).toBe(seeded.tokens.refresh_token);
    expect(revoke.get("token_type_hint")).toBe("refresh_token");
    expectNoSecretsInLogs();
  });

  it("keeps a connection that another tab made during the revoke", async () => {
    await seedConnection(accounts, app, "notion", { userId: USER });
    let reconnect: Awaited<ReturnType<typeof seedConnection>> | null = null;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (input.endsWith("/revoke")) reconnect = await seedConnection(accounts, app, "notion", { userId: USER });
      return app.fetch(input, init);
    });
    const response = await disconnectRoute.POST(post("/api/connectors/mcp/notion/disconnect"), params("notion"));
    expect(outcome(response)).toBe("disconnect_changed");
    expect((await accounts.getMcp(USER, "notion"))!.tokenCiphertext).toBe(reconnect!.sealed);
  });

  it("says unconfirmed when the app does not confirm the revoke, and still deletes", async () => {
    await seedConnection(accounts, app, "notion", { userId: USER });
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) =>
      input.endsWith("/revoke") ? new Response(null, { status: 503 }) : app.fetch(input, init),
    );
    expect(outcome(await disconnectRoute.POST(post("/api/connectors/mcp/notion/disconnect"), params("notion")))).toBe(
      "disconnected_unconfirmed",
    );
    expect(accounts.rows.size).toBe(0);
  });

  it("refuses an anonymous session before any read", async () => {
    await seedConnection(accounts, app, "notion", { userId: USER });
    signInAs(USER, true);
    const response = await disconnectRoute.POST(post("/api/connectors/mcp/notion/disconnect"), params("notion"));
    expect(response.status).toBe(403);
    expect(quotaCalls).toBe(0);
    expect(accounts.rows.size).toBe(1);
  });

  it("checks the quota and the delete with a write-fault sweep, and a retry ends with no row", async () => {
    await sweepWriteFaults(async (faults) => {
      accounts = new FakeMcpAccounts();
      app = fakeApp("notion");
      vi.stubGlobal("fetch", app.fetch);
      await seedConnection(accounts, app, "notion", { userId: USER });
      quota = new Quota();
      faults.wrap(quota, ["consume"], { label: "quota" });
      faults.wrap(accounts, ["deleteMcp"], { label: "accounts" });
      faults.wrap(accounts, ["getMcp"], { label: "accounts", read: true });
      const first = await disconnectRoute.POST(post("/api/connectors/mcp/notion/disconnect"), params("notion"));
      expect(first.status).toBe(303);
      const done = outcome(first);
      expect(["disconnected", "disconnected_unconfirmed", "disconnect_error", "disconnect_unknown"]).toContain(done);
      if (done === "disconnected" || done === "disconnected_unconfirmed") expect(accounts.rows.size).toBe(0);
      faults.disarm();
      const retry = await disconnectRoute.POST(post("/api/connectors/mcp/notion/disconnect"), params("notion"));
      expect(["disconnected", "disconnected_unconfirmed"]).toContain(outcome(retry));
      expect(accounts.rows.size).toBe(0);
    });
  });
});

