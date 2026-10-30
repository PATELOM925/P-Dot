import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/server/auth/session";
import type { OneCallTool } from "@/server/mcp/catalog";
import { FakeMcpAccounts, TEST_KEY, TEST_USER, fakeApp, seedConnection, type FakeApp } from "../support/fake-mcp";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/db/connected-accounts", () => ({ createMcpAccountRepository: vi.fn() }));
vi.mock("@/server/db/quota", () => ({ createQuotaGate: vi.fn() }));

const { getAuthContext } = await import("@/server/auth/session");
const { createMcpAccountRepository } = await import("@/server/db/connected-accounts");
const { createQuotaGate } = await import("@/server/db/quota");
const connectRoute = await import("@/app/api/connectors/mcp/[server]/connect/route");
const callbackRoute = await import("@/app/api/connectors/mcp/callback/route");
const { openBundle } = await import("@/server/mcp/bundle");
const { MCP_SERVERS, githubId } = await import("@/server/mcp/catalog");
const { TurnIds } = await import("@/server/mcp/outbound");
const { openMcpAccess } = await import("@/server/mcp/token-store");
const { createConnectorServices } = await import("@/server/mcp/connector-turn");
const { isMcpServerReady, getMcpClientCredentials } = await import("@/server/config");

/** Decision 0020: GitHub through the MCP framework, with a confidential client from env. */
const SITE = "https://pdot.example";
const KEY = Buffer.from(TEST_KEY).toString("base64");
const github = MCP_SERVERS.github;

let accounts: FakeMcpAccounts;
let app: FakeApp;
let logs: string[];

function signIn() {
  vi.mocked(getAuthContext).mockResolvedValue({ userId: TEST_USER, email: null, isAnonymous: false, supabase: {} as SupabaseClient } satisfies AuthContext);
}

const post = (path: string) => new Request(`${SITE}${path}`, { method: "POST", headers: { host: "pdot.example", origin: SITE } });
const outcome = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("mcp");

async function startConnect() {
  const response = await connectRoute.POST(post("/api/connectors/mcp/github/connect"), { params: Promise.resolve({ server: "github" }) });
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location")!);
  const cookie = /pdot_mcp_oauth=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  return { location, state: location.searchParams.get("state")!, cookie: cookie! };
}

function callback(query: Record<string, string>, cookie: string) {
  const url = new URL(`${SITE}/api/connectors/mcp/callback`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return callbackRoute.GET(new NextRequest(url, { headers: { host: "pdot.example", cookie: `pdot_mcp_oauth=${cookie}` } }));
}

beforeEach(() => {
  accounts = new FakeMcpAccounts();
  vi.mocked(createMcpAccountRepository).mockImplementation(() => accounts);
  vi.mocked(createQuotaGate).mockImplementation(() => ({ consume: async () => ({ allowed: true, resetsAt: new Date() }) }));
  vi.stubEnv("SITE_URL", SITE);
  vi.stubEnv("CONNECTOR_TOKEN_ENCRYPTION_KEY", KEY);
  vi.stubEnv("NEBIUS_API_KEY", "test-key");
  vi.stubEnv("GITHUB_MCP_CLIENT_ID", "github-client");
  vi.stubEnv("GITHUB_MCP_CLIENT_SECRET", "github-secret");
  app = fakeApp("github");
  vi.stubGlobal("fetch", app.fetch);
  logs = [];
  for (const method of ["info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
  }
  signIn();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHub settings", () => {
  it("is ready only with the sealing key, the client ID and the client secret", () => {
    const env = { CONNECTOR_TOKEN_ENCRYPTION_KEY: KEY, GITHUB_MCP_CLIENT_ID: "Iv23liAbc", GITHUB_MCP_CLIENT_SECRET: "s3cret" } as unknown as NodeJS.ProcessEnv;
    expect(isMcpServerReady("github", env)).toBe(true);
    expect(isMcpServerReady("github", { ...env, GITHUB_MCP_CLIENT_SECRET: "" })).toBe(false);
    expect(isMcpServerReady("github", { ...env, GITHUB_MCP_CLIENT_ID: "" })).toBe(false);
    expect(isMcpServerReady("github", { ...env, GITHUB_MCP_CLIENT_ID: "bad id" })).toBe(false);
    expect(isMcpServerReady("github", { ...env, CONNECTOR_TOKEN_ENCRYPTION_KEY: "" })).toBe(false);
    // The apps with a public client need only the key, as before.
    expect(isMcpServerReady("notion", { CONNECTOR_TOKEN_ENCRYPTION_KEY: KEY } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(getMcpClientCredentials("notion", env)).toBeNull();
  });
});

describe("GitHub Connect and callback", () => {
  it("uses the env client ID with no CIMD or DCR, sends no scope, and asks for consent at github.com", async () => {
    const { location } = await startConnect();
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("github-client");
    expect(location.searchParams.has("scope")).toBe(false);
    expect(location.searchParams.get("resource")).toBe("https://api.githubcopilot.com/mcp/readonly");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.toString()).not.toContain("github-secret");
    expect(app.calls.map((call) => call.url)).toEqual([
      "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/readonly",
      "https://github.com/.well-known/oauth-authorization-server/login/oauth",
    ]);
  });

  it("sends the secret only to the token endpoint, stores the read label and pins only the read tools", async () => {
    const { state, cookie } = await startConnect();
    const response = await callback({ code: "good-code", state, iss: "https://github.com/login/oauth" }, cookie);
    expect(outcome(response)).toBe("connected");
    const withSecret = app.calls.filter((call) => call.body.includes("github-secret") || JSON.stringify(call.headers).includes("github-secret"));
    expect(withSecret.map((call) => call.url)).toEqual(["https://github.com/login/oauth/access_token"]);
    const row = (await accounts.getMcp(TEST_USER, "github"))!;
    expect(row.scopes).toEqual(["read"]);
    const bundle = (await openBundle(TEST_KEY, TEST_USER, github, row.subject, row.tokenCiphertext))!;
    expect(bundle.clientId).toBe("github-client");
    expect(bundle.revocationEndpoint).toBeNull();
    expect(Object.keys(bundle.pins).sort()).toEqual(["get_file_contents", "get_me", "list_pull_requests", "search_issues", "search_pull_requests", "search_repositories"]);
    expect(JSON.stringify(bundle)).not.toContain("github-secret");
    expect(logs.join("\n")).not.toMatch(/github-secret|access-github/);
  });

  it("refuses a callback without iss, because GitHub says it sends one", async () => {
    const { state, cookie } = await startConnect();
    expect(outcome(await callback({ code: "good-code", state }, cookie))).toBe("error");
    expect(accounts.rows.size).toBe(0);
  });

  it("stores nothing when GitHub answers a wrong secret with status 200 and an error", async () => {
    const { state, cookie } = await startConnect();
    vi.stubEnv("GITHUB_MCP_CLIENT_SECRET", "wrong-secret");
    expect(outcome(await callback({ code: "good-code", state, iss: "https://github.com/login/oauth" }, cookie))).toBe("error");
    expect(accounts.rows.size).toBe(0);
  });

  it("calls nothing when the client settings are gone or changed before the callback", async () => {
    const { state, cookie } = await startConnect();
    const before = app.calls.length;
    vi.stubEnv("GITHUB_MCP_CLIENT_SECRET", "");
    expect(outcome(await callback({ code: "good-code", state, iss: "https://github.com/login/oauth" }, cookie))).toBe("not_set_up");
    vi.stubEnv("GITHUB_MCP_CLIENT_SECRET", "github-secret");
    vi.stubEnv("GITHUB_MCP_CLIENT_ID", "another-client");
    expect(outcome(await callback({ code: "good-code", state, iss: "https://github.com/login/oauth" }, cookie))).toBe("not_set_up");
    expect(app.calls.length).toBe(before);
    expect(accounts.rows.size).toBe(0);
  });

  it("does not connect without the client settings, and calls nothing", async () => {
    vi.stubEnv("GITHUB_MCP_CLIENT_ID", "");
    const response = await connectRoute.POST(post("/api/connectors/mcp/github/connect"), { params: Promise.resolve({ server: "github" }) });
    expect(outcome(response)).toBe("not_set_up");
    expect(app.calls).toEqual([]);
  });
});

describe("GitHub refresh", () => {
  it("sends the client secret with the refresh token", async () => {
    await seedConnection(accounts, app, "github", { accessExpiresAt: Date.now() + 1000 });
    const access = await openMcpAccess({
      repo: accounts,
      key: TEST_KEY,
      server: github,
      userId: TEST_USER,
      fetch: app.fetch,
      requestId: "req",
      log: () => undefined,
      sleep: async () => undefined,
    });
    expect(await access.token(false)).toMatch(/^access-github-/);
    const refresh = new URLSearchParams(app.calls.find((call) => call.body.includes("refresh_token"))!.body);
    expect(refresh.get("client_secret")).toBe("github-secret");
    expect(refresh.get("client_id")).toBe("github-client");
  });
});

describe("GitHub IDs and arguments", () => {
  it("reads repositories and file links in the user's text, never other text", () => {
    const text = "List PRs in Vercel/Next.js and read https://github.com/octo/repo/blob/main/docs/a%20b.md. Not https://evil.example/x/y";
    expect(new Set(github.idsInUserText(text))).toEqual(
      new Set(["vercel/next.js", "octo/repo", "https://github.com/octo/repo/blob/main/docs/a b.md"]),
    );
    expect(githubId("Vercel/Next.js")).toBe("vercel/next.js");
    expect(githubId("https://github.com/octo/repo")).toBe("octo/repo");
    expect(githubId("https://github.com/octo/repo/blob/main/../secret")).toBeNull();
    expect(githubId("https://github.com.evil.example/octo/repo")).toBeNull();
    expect(githubId("http://github.com/octo/repo")).toBeNull();
    expect(githubId("octo/..")).toBeNull();
  });

  it("builds the remote arguments from the checked ID only", () => {
    const [, list, read] = github.tools as OneCallTool[];
    expect(list!.remoteArgs({ repo: "vercel/next.js" })).toEqual({ owner: "vercel", repo: "next.js", state: "open", perPage: 10 });
    expect(read!.remoteArgs({ url: "https://github.com/octo/repo/blob/v1.2/src/index.ts" })).toEqual({
      owner: "octo",
      repo: "repo",
      path: "src/index.ts",
      ref: "v1.2",
    });
    expect(read!.args.safeParse({ url: "https://github.com/octo/repo" }).success).toBe(false);
  });

  it("allows a repository only when the user named it in this turn", () => {
    const ids = new TurnIds("show open PRs in octo/repo", [github]);
    expect(ids.allowed(github, "Octo/Repo")).toBe("octo/repo");
    expect(ids.allowed(github, "octo/other")).toBeNull();
    expect(ids.allowed(github, "https://github.com/octo/repo/blob/main/secret.txt")).toBeNull();
  });

  it("refuses a repository from a result in chat and sends nothing", async () => {
    await seedConnection(accounts, app, "github");
    const services = createConnectorServices({
      repo: accounts,
      key: TEST_KEY,
      userId: TEST_USER,
      anonymous: false,
      fetch: app.fetch,
      log: () => undefined,
    });
    const turn = services.startTurn({ requestId: "r", userMessage: "what is open in octo/repo", servers: ["github"], signal: new AbortController().signal });
    const [, list] = github.tools;
    const before = app.mcpCalls().length;
    expect(await turn.run(github, list!, { repo: "attacker/exfil" })).toMatch(/^Not sent/);
    expect(app.mcpCalls().length).toBe(before);
    expect(await turn.run(github, list!, { repo: "octo/repo" })).toContain("untrusted_connector_data");
    expect(app.toolCalls()).toEqual([{ name: "list_pull_requests", arguments: { owner: "octo", repo: "repo", state: "open", perPage: 10 } }]);
    turn.close();
  });

  it("does not offer GitHub in chat when its settings are missing", async () => {
    await seedConnection(accounts, app, "github");
    const deps = { repo: accounts, key: TEST_KEY, userId: TEST_USER, anonymous: false, fetch: app.fetch, log: () => undefined };
    expect((await createConnectorServices({ ...deps, isReady: () => true }).available(["github"])).has("github")).toBe(true);
    expect((await createConnectorServices({ ...deps, isReady: (id) => id !== "github" }).available(["github"])).has("github")).toBe(false);
  });
});
