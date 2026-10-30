import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/server/auth/session";
import type { ConnectedAccountRepository, GoogleTokenRow } from "@/server/db/connected-accounts";
import type { DataScope } from "@/server/google/oauth";
import { REVOKE_URL, TOKEN_URL, fakeGoogle, idToken, json, type GoogleHandler } from "../support/fake-google";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/db/connected-accounts", () => ({ createConnectedAccountRepository: vi.fn() }));

const { getAuthContext } = await import("@/server/auth/session");
const { createConnectedAccountRepository } = await import("@/server/db/connected-accounts");
const connectRoute = await import("@/app/api/connectors/google/connect/route");
const callbackRoute = await import("@/app/api/connectors/google/callback/route");
const disconnectRoute = await import("@/app/api/connectors/google/disconnect/route");
const { openText, tokenAssociatedData } = await import("@/server/google/crypto");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY_BYTES = new Uint8Array(32).fill(7);
const KEY = Buffer.from(KEY_BYTES).toString("base64");
const REFRESH = "1//refresh-token-secret-value";
const ACCESS = "ya29.access-token-secret-value";
const CODE = "4/auth-code-secret-value";
const ADDRESS = "alice.private@example.com";
const ALL_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events.owned",
].join(" ");

class FakeAccounts implements ConnectedAccountRepository {
  rows = new Map<string, GoogleTokenRow>();
  failSave = false;
  failDelete = false;
  deletes = 0;

  async getGoogleConnection(userId: string) {
    const row = this.rows.get(userId);
    return row ? { email: row.email, scopes: row.scopes, status: row.status } : null;
  }
  failReadAfterDelete = false;
  async getGoogleToken(userId: string) {
    if (this.failReadAfterDelete && this.deletes > 0) throw new Error("read failed");
    return this.rows.get(userId) ?? null;
  }
  owner = ALICE;
  async saveGoogle(subject: string, email: string, scopes: DataScope[], tokenCiphertext: string) {
    if (this.failSave) throw new Error("save failed");
    this.rows.set(this.owner, { subject, email, scopes, tokenCiphertext, status: "connected" });
  }
  async markGoogleNeedsReconnect() {}
  async deleteGoogle(userId: string, tokenCiphertext: string) {
    this.deletes += 1;
    if (this.failDelete) throw new Error("delete failed");
    if (this.rows.get(userId)?.tokenCiphertext !== tokenCiphertext) return false;
    return this.rows.delete(userId);
  }
}

let accounts: FakeAccounts;
let logs: string[];

function signInAs(userId: string | null, isAnonymous = false) {
  vi.mocked(getAuthContext).mockResolvedValue(
    userId ? ({ userId, email: null, isAnonymous, supabase: {} as SupabaseClient } satisfies AuthContext) : null,
  );
  accounts.owner = userId ?? "";
}

function stubGoogle(handlers: Record<string, GoogleHandler>) {
  const google = fakeGoogle(handlers);
  vi.stubGlobal("fetch", google.fetch);
  return google;
}

const tokenAnswer = (scope = ALL_SCOPES) =>
  json({
    access_token: ACCESS,
    expires_in: 3599,
    refresh_token: REFRESH,
    scope,
    token_type: "Bearer",
    id_token: idToken({ sub: "google-sub-123", email: ADDRESS, email_verified: true }),
  });

const post = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { host: "localhost", origin: "http://localhost", ...headers } });

/** Runs Connect as the signed-in user and returns the state and the sealed cookie. */
async function startConnect() {
  const response = await connectRoute.POST(post("/api/connectors/google/connect"));
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location")!);
  const cookie = /pdot_google_oauth=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")![1]!;
  return { location, state: location.searchParams.get("state")!, cookie, setCookie: response.headers.get("set-cookie")! };
}

function callback(params: Record<string, string>, cookie?: string) {
  const url = new URL("http://localhost/api/connectors/google/callback");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return callbackRoute.GET(
    new NextRequest(url, { headers: { host: "localhost", ...(cookie ? { cookie: `pdot_google_oauth=${cookie}` } : {}) } }),
  );
}

const outcome = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("google");

beforeEach(() => {
  accounts = new FakeAccounts();
  vi.mocked(createConnectedAccountRepository).mockReturnValue(accounts);
  vi.stubEnv("SITE_URL", "http://localhost");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client-id.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "client-secret-value");
  vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", KEY);
  logs = [];
  for (const method of ["info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
  }
  signInAs(ALICE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function expectNoSecretsInLogs() {
  const text = logs.join("\n");
  for (const secret of [REFRESH, ACCESS, CODE, ADDRESS, "client-secret-value", KEY]) expect(text).not.toContain(secret);
}

describe("POST /api/connectors/google/connect", () => {
  it("redirects to Google with PKCE, offline access, consent and only the chosen scopes, and seals the state in an httpOnly cookie", async () => {
    const { location, setCookie } = await startConnect();
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-id.apps.googleusercontent.com",
      redirect_uri: "http://localhost/api/connectors/google/callback",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      scope:
        "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events.owned",
    });
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toMatch(/Path=\/api\/connectors\/google/);
    expect(setCookie).toMatch(/Max-Age=600/);
    expect(setCookie).not.toContain(location.searchParams.get("state")!);
  });

  it("refuses a cross-origin form and a signed-out user", async () => {
    expect((await connectRoute.POST(post("/api/connectors/google/connect", { origin: "https://evil.example" }))).status).toBe(403);
    signInAs(null);
    expect((await connectRoute.POST(post("/api/connectors/google/connect"))).status).toBe(401);
  });

  it("says not set up when a setting is missing or the key is bad, and calls nothing", async () => {
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", "short");
    const response = await connectRoute.POST(post("/api/connectors/google/connect"));
    expect(outcome(response)).toBe("not_set_up");
    expect(logs.join("\n")).toContain("GOOGLE_TOKEN_ENCRYPTION_KEY");
    expect(logs.join("\n")).not.toContain("short");
  });

  it("refuses a host that is not SITE_URL, because Google returns to SITE_URL", async () => {
    vi.stubEnv("SITE_URL", "https://pdot.iampatelom.com");
    expect(outcome(await connectRoute.POST(post("/api/connectors/google/connect")))).toBe("wrong_site");
  });
});

describe("GET /api/connectors/google/callback", () => {
  it("exchanges the code with the verifier, stores only the encrypted refresh token with the subject and granted scopes, and deletes the cookie", async () => {
    const { state, cookie } = await startConnect();
    const google = stubGoogle({ [TOKEN_URL]: () => tokenAnswer() });
    const response = await callback({ code: CODE, state }, cookie);
    expect(outcome(response)).toBe("connected");
    expect(response.headers.get("set-cookie")).toMatch(/pdot_google_oauth=;.*Max-Age=0/i);

    const sent = new URLSearchParams(google.calls[0]!.body);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe(CODE);
    expect(sent.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sent.get("redirect_uri")).toBe("http://localhost/api/connectors/google/callback");

    const row = accounts.rows.get(ALICE)!;
    expect(row).toMatchObject({ subject: "google-sub-123", email: ADDRESS, status: "connected" });
    expect(row.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.events.owned",
    ]);
    expect(row.tokenCiphertext).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/);
    expect(row.tokenCiphertext).not.toContain(REFRESH);
    expect(await openText(KEY_BYTES, row.tokenCiphertext, tokenAssociatedData(ALICE, "google"))).toBe(REFRESH);
    expect(await openText(KEY_BYTES, row.tokenCiphertext, tokenAssociatedData(BOB, "google"))).toBeNull();
    expectNoSecretsInLogs();
  });

  it("keeps only granted data scopes when the user clears some boxes", async () => {
    const { state, cookie } = await startConnect();
    stubGoogle({ [TOKEN_URL]: () => tokenAnswer("openid https://www.googleapis.com/auth/calendar.events.owned") });
    expect(outcome(await callback({ code: CODE, state }, cookie))).toBe("connected");
    expect(accounts.rows.get(ALICE)!.scopes).toEqual(["https://www.googleapis.com/auth/calendar.events.owned"]);
  });

  it("stores nothing and revokes the token when no data scope was granted", async () => {
    const { state, cookie } = await startConnect();
    const google = stubGoogle({ [TOKEN_URL]: () => tokenAnswer("openid email"), [REVOKE_URL]: () => json({}) });
    expect(outcome(await callback({ code: CODE, state }, cookie))).toBe("no_scopes");
    expect(accounts.rows.size).toBe(0);
    expect(google.calls.map((call) => call.url)).toEqual([TOKEN_URL, REVOKE_URL]);
  });

  it.each([
    ["no cookie", (s: { state: string; cookie: string }) => callback({ code: CODE, state: s.state })],
    ["another state", (s: { state: string; cookie: string }) => callback({ code: CODE, state: `${s.state}x` }, s.cookie)],
    ["no state", (s: { state: string; cookie: string }) => callback({ code: CODE }, s.cookie)],
    ["a changed cookie", (s: { state: string; cookie: string }) => callback({ code: CODE, state: s.state }, `${s.cookie.slice(0, -2)}AA`)],
  ])("refuses %s and calls nothing", async (_name, run) => {
    const started = await startConnect();
    const google = stubGoogle({ [TOKEN_URL]: () => tokenAnswer() });
    expect(outcome(await run(started))).toBe("error");
    expect(google.calls).toEqual([]);
    expect(accounts.rows.size).toBe(0);
  });

  it("refuses a cookie made for another user", async () => {
    const { state, cookie } = await startConnect();
    signInAs(BOB);
    const google = stubGoogle({ [TOKEN_URL]: () => tokenAnswer() });
    expect(outcome(await callback({ code: CODE, state }, cookie))).toBe("error");
    expect(google.calls).toEqual([]);
  });

  it("refuses an expired cookie", async () => {
    const { state, cookie } = await startConnect();
    vi.useFakeTimers({ now: Date.now() + 601_000, toFake: ["Date"] });
    try {
      const google = stubGoogle({ [TOKEN_URL]: () => tokenAnswer() });
      expect(outcome(await callback({ code: CODE, state }, cookie))).toBe("error");
      expect(google.calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a signed-out browser to the login page and calls nothing", async () => {
    const { state, cookie } = await startConnect();
    signInAs(null);
    const response = await callback({ code: CODE, state }, cookie);
    expect(response.headers.get("location")).toBe("http://localhost/login?next=/connectors");
  });

  it("shows denied when the user cancels on Google's screen", async () => {
    const { state, cookie } = await startConnect();
    expect(outcome(await callback({ error: "access_denied", state }, cookie))).toBe("denied");
  });

  it.each([
    ["a 400 from Google", () => json({ error: "invalid_grant" }, 400)],
    ["a 500 from Google", () => json({}, 500)],
    ["an answer without a refresh token", () => json({ access_token: ACCESS, expires_in: 10, scope: ALL_SCOPES, id_token: idToken({ sub: "s", email: ADDRESS }) })],
    ["an ID token without a subject", () => json({ access_token: ACCESS, expires_in: 10, refresh_token: REFRESH, scope: ALL_SCOPES, id_token: idToken({ email: ADDRESS }) })],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
  ])("shows the error state for %s and stores nothing", async (_name, handler) => {
    const { state, cookie } = await startConnect();
    stubGoogle({ [TOKEN_URL]: handler as GoogleHandler });
    expect(outcome(await callback({ code: CODE, state }, cookie))).toBe("error");
    expect(accounts.rows.size).toBe(0);
    expectNoSecretsInLogs();
  });

  it("shows the error state when the save fails", async () => {
    const { state, cookie } = await startConnect();
    stubGoogle({ [TOKEN_URL]: () => tokenAnswer() });
    accounts.failSave = true;
    expect(outcome(await callback({ code: CODE, state }, cookie))).toBe("error");
    expectNoSecretsInLogs();
  });
});

describe("anonymous demo sessions", () => {
  it("cannot start Connect, finish it, or Disconnect: 403 account_required, and nothing calls Google", async () => {
    const { state, cookie } = await startConnect();
    signInAs(ALICE, true);
    const google = stubGoogle({ [TOKEN_URL]: () => tokenAnswer(), [REVOKE_URL]: () => json({}) });
    for (const response of [
      await connectRoute.POST(post("/api/connectors/google/connect")),
      await callback({ code: CODE, state }, cookie),
      await disconnectRoute.POST(post("/api/connectors/google/disconnect")),
    ]) {
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("account_required");
    }
    expect(google.calls).toEqual([]);
    expect(accounts.rows.size).toBe(0);
  });
});

describe("POST /api/connectors/google/disconnect", () => {
  async function connected() {
    const { state, cookie } = await startConnect();
    stubGoogle({ [TOKEN_URL]: () => tokenAnswer() });
    await callback({ code: CODE, state }, cookie);
    expect(accounts.rows.has(ALICE)).toBe(true);
  }

  it("revokes the refresh token at Google, then deletes the row", async () => {
    await connected();
    const google = stubGoogle({ [REVOKE_URL]: () => json({}) });
    expect(outcome(await disconnectRoute.POST(post("/api/connectors/google/disconnect")))).toBe("disconnected");
    expect(new URLSearchParams(google.calls[0]!.body).get("token")).toBe(REFRESH);
    expect(accounts.rows.size).toBe(0);
    expectNoSecretsInLogs();
  });

  it("treats 400 (a token that already ended) as done", async () => {
    await connected();
    stubGoogle({ [REVOKE_URL]: () => json({ error: "invalid_token" }, 400) });
    expect(outcome(await disconnectRoute.POST(post("/api/connectors/google/disconnect")))).toBe("disconnected");
    expect(accounts.rows.size).toBe(0);
  });

  it.each([
    ["a 503", () => json({}, 503)],
    ["a timeout", () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))],
  ])("still deletes the row after %s and says Google did not confirm", async (_name, handler) => {
    await connected();
    stubGoogle({ [REVOKE_URL]: handler as GoogleHandler });
    expect(outcome(await disconnectRoute.POST(post("/api/connectors/google/disconnect")))).toBe("disconnected_unconfirmed");
    expect(accounts.rows.size).toBe(0);
  });

  it("keeps the row when the delete fails, and a second Disconnect finishes it", async () => {
    await connected();
    stubGoogle({ [REVOKE_URL]: () => json({}) });
    accounts.failDelete = true;
    expect(outcome(await disconnectRoute.POST(post("/api/connectors/google/disconnect")))).toBe("disconnect_error");
    expect(accounts.rows.has(ALICE)).toBe(true);
    accounts.failDelete = false;
    stubGoogle({ [REVOKE_URL]: () => json({ error: "invalid_token" }, 400) });
    expect(outcome(await disconnectRoute.POST(post("/api/connectors/google/disconnect")))).toBe("disconnected");
    expect(accounts.rows.size).toBe(0);
  });

  it("keeps a connection that another tab made while the revoke ran, and says so", async () => {
    await connected();
    const replacement: GoogleTokenRow = {
      subject: "google-sub-other",
      email: "other@example.com",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "connected",
      tokenCiphertext: `v1.${"C".repeat(16)}.${"D".repeat(40)}`,
    };
    const google = stubGoogle({
      [REVOKE_URL]: () => {
        accounts.rows.set(ALICE, replacement);
        return json({});
      },
    });
    expect(outcome(await disconnectRoute.POST(post("/api/connectors/google/disconnect")))).toBe("disconnect_changed");
    expect(accounts.rows.get(ALICE)).toEqual(replacement);
    expect(new URLSearchParams(google.calls[0]!.body).get("token")).toBe(REFRESH);
  });

  it("never says disconnected when nothing was deleted and the check read fails", async () => {
    await connected();
    stubGoogle({
      [REVOKE_URL]: () => {
        accounts.rows.set(ALICE, { ...accounts.rows.get(ALICE)!, tokenCiphertext: `v1.${"E".repeat(16)}.${"F".repeat(40)}` });
        return json({});
      },
    });
    accounts.failReadAfterDelete = true;
    const response = await disconnectRoute.POST(post("/api/connectors/google/disconnect"));
    expect(outcome(response)).toBe("disconnect_unknown");
    expect(accounts.rows.has(ALICE)).toBe(true);
  });

  it("deletes the row without a revoke when Google is not set up any more", async () => {
    await connected();
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", "");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "");
    const google = stubGoogle({});
    expect(outcome(await disconnectRoute.POST(post("/api/connectors/google/disconnect")))).toBe("disconnected_unconfirmed");
    expect(google.calls).toEqual([]);
    expect(accounts.rows.size).toBe(0);
  });

  it("answers disconnected when there is no row, and refuses a cross-origin form", async () => {
    expect(outcome(await disconnectRoute.POST(post("/api/connectors/google/disconnect")))).toBe("disconnected");
    expect((await disconnectRoute.POST(post("/api/connectors/google/disconnect", { origin: "https://evil.example" }))).status).toBe(403);
  });
});
