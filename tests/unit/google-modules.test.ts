import { afterEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_NAMES } from "../../scripts/worker-env-rules.mjs";
import { getGoogleConfig, type GoogleConfig } from "@/server/config";
import { openText, pkceChallenge, sameText, sealText, tokenAssociatedData } from "@/server/google/crypto";
import { openOAuthState, sealOAuthState } from "@/server/google/oauth-state";
import { openGoogleAccess, GoogleReconnectNeededError } from "@/server/google/token-store";
import type { ConnectedAccountRepository, GoogleTokenRow } from "@/server/db/connected-accounts";
import { googleCardState, googleOutcomeMessage } from "@/features/connectors/google";
import { GoogleApiError } from "@/server/google/http";
import { TOKEN_URL, fakeGoogle, json } from "../support/fake-google";

const KEY = new Uint8Array(32).fill(3);
const OTHER_KEY = new Uint8Array(32).fill(4);
const CONFIG: GoogleConfig = { clientId: "id", clientSecret: "secret", encryptionKey: KEY, redirectUri: "http://localhost/cb" };
const B64_KEY = Buffer.from(KEY).toString("base64");

afterEach(() => vi.unstubAllEnvs());

describe("getGoogleConfig", () => {
  const env = (values: Record<string, string | undefined>) => ({ SITE_URL: "https://pdot.iampatelom.com", ...values }) as NodeJS.ProcessEnv;

  it("is ready with all three values and builds the callback from SITE_URL", () => {
    const state = getGoogleConfig(env({ GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "s", GOOGLE_TOKEN_ENCRYPTION_KEY: B64_KEY }));
    expect(state).toMatchObject({ status: "ready", config: { redirectUri: "https://pdot.iampatelom.com/api/connectors/google/callback" } });
  });

  it("is not set up with no values, and names only the bad ones otherwise", () => {
    expect(getGoogleConfig(env({}))).toEqual({ status: "not_set_up", invalid: [] });
    expect(getGoogleConfig(env({ GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_TOKEN_ENCRYPTION_KEY: "dG9vIHNob3J0" }))).toEqual({
      status: "not_set_up",
      invalid: ["GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_TOKEN_ENCRYPTION_KEY"],
    });
  });

  it("allows only the public client ID in the Worker bundle env, never the secret or the key", () => {
    expect(ALLOWED_NAMES.has("GOOGLE_OAUTH_CLIENT_ID")).toBe(true);
    expect(ALLOWED_NAMES.has("GOOGLE_OAUTH_CLIENT_SECRET")).toBe(false);
    expect(ALLOWED_NAMES.has("GOOGLE_TOKEN_ENCRYPTION_KEY")).toBe(false);
  });
});

describe("GET /api/health", () => {
  it("reports google true or false and no values", async () => {
    const { GET } = await import("@/app/api/health/route");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    expect((await GET().json()).configured.google).toBe(false);
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client-id-value");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "secret-value");
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", B64_KEY);
    const body = await GET().text();
    expect(JSON.parse(body).configured.google).toBe(true);
    for (const secret of ["client-id-value", "secret-value", B64_KEY]) expect(body).not.toContain(secret);
  });
});

describe("token sealing", () => {
  it("opens only with the same key and associated data, and refuses a changed value", async () => {
    const sealed = await sealText(KEY, "refresh", tokenAssociatedData("u1", "google"));
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/);
    expect(await openText(KEY, sealed, tokenAssociatedData("u1", "google"))).toBe("refresh");
    expect(await openText(KEY, sealed, tokenAssociatedData("u2", "google"))).toBeNull();
    expect(await openText(OTHER_KEY, sealed, tokenAssociatedData("u1", "google"))).toBeNull();
    const [v, iv, body] = sealed.split(".");
    const flipped = `${v}.${iv}.${body!.slice(0, -1)}${body!.endsWith("A") ? "B" : "A"}`;
    expect(await openText(KEY, flipped, tokenAssociatedData("u1", "google"))).toBeNull();
    expect(await openText(KEY, "v2.x.y", "ad")).toBeNull();
    expect(sealed).not.toBe(await sealText(KEY, "refresh", tokenAssociatedData("u1", "google")));
  });

  it("makes the RFC 7636 S256 challenge", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("compares strings in full", () => {
    expect(sameText("abc", "abc")).toBe(true);
    expect(sameText("abc", "abd")).toBe(false);
    expect(sameText("abc", "abcd")).toBe(false);
  });

  it("opens the state cookie only before it expires", async () => {
    const value = { userId: "u1", state: "s".repeat(43), verifier: "v".repeat(43), expiresAt: 2_000 };
    const sealed = await sealOAuthState(KEY, value);
    expect(await openOAuthState(KEY, sealed, 1_999)).toEqual(value);
    expect(await openOAuthState(KEY, sealed, 2_000)).toBeNull();
    const token = await sealText(KEY, JSON.stringify({ u: "u1", s: "s".repeat(43), v: "v".repeat(43), e: 9_999 }), tokenAssociatedData("u1", "google"));
    expect(await openOAuthState(KEY, token, 1)).toBeNull();
  });
});

describe("openGoogleAccess", () => {
  class Accounts implements Pick<ConnectedAccountRepository, "getGoogleToken" | "markGoogleNeedsReconnect"> {
    marked: string[] = [];
    constructor(public row: GoogleTokenRow | null) {}
    async getGoogleToken() {
      return this.row;
    }
    async markGoogleNeedsReconnect(_userId: string, ciphertext: string) {
      this.marked.push(ciphertext);
    }
  }

  async function connectedRow(): Promise<GoogleTokenRow> {
    return {
      subject: "sub-1",
      email: "a@example.com",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "connected",
      tokenCiphertext: await sealText(KEY, "refresh-1", tokenAssociatedData("u1", "google")),
    };
  }

  const open = (accounts: Accounts, fetch: ReturnType<typeof fakeGoogle>["fetch"], now = () => 0) =>
    openGoogleAccess({ repo: accounts as unknown as ConnectedAccountRepository, config: CONFIG, fetch, userId: "u1", requestId: "r", now });

  it("refreshes once, keeps the access token in memory and refreshes again near its end", async () => {
    const google = fakeGoogle({ [TOKEN_URL]: () => json({ access_token: "at", expires_in: 3600 }) });
    let time = 0;
    const result = await open(new Accounts(await connectedRow()), google.fetch, () => time);
    if (!result.ok) throw new Error("not ok");
    expect(result.access.subject).toBe("sub-1");
    expect(await Promise.all([result.access.accessToken(), result.access.accessToken()])).toEqual(["at", "at"]);
    expect(google.calls).toHaveLength(1);
    expect(new URLSearchParams(google.calls[0]!.body).get("refresh_token")).toBe("refresh-1");
    time = 3_600_000 - 59_000;
    await result.access.accessToken();
    expect(google.calls).toHaveLength(2);
  });

  it("marks the row on invalid_grant and asks for a reconnect", async () => {
    const accounts = new Accounts(await connectedRow());
    const google = fakeGoogle({ [TOKEN_URL]: () => json({ error: "invalid_grant" }, 400) });
    const result = await open(accounts, google.fetch);
    if (!result.ok) throw new Error("not ok");
    await expect(result.access.accessToken()).rejects.toBeInstanceOf(GoogleReconnectNeededError);
    expect(accounts.marked).toEqual([accounts.row!.tokenCiphertext]);
  });

  it("does not mark the row for an outage", async () => {
    const accounts = new Accounts(await connectedRow());
    const result = await open(accounts, fakeGoogle({ [TOKEN_URL]: () => json({}, 503) }).fetch);
    if (!result.ok) throw new Error("not ok");
    await expect(result.access.accessToken()).rejects.toMatchObject({ kind: "unavailable" });
    expect(accounts.marked).toEqual([]);
  });

  it("answers not_connected, needs_reconnect, and needs_reconnect for a ciphertext that does not open", async () => {
    const google = fakeGoogle({});
    expect(await open(new Accounts(null), google.fetch)).toEqual({ ok: false, reason: "not_connected" });
    expect(await open(new Accounts({ ...(await connectedRow()), status: "needs_reconnect" }), google.fetch)).toEqual({ ok: false, reason: "needs_reconnect" });
    const other = new Accounts({ ...(await connectedRow()), tokenCiphertext: await sealText(OTHER_KEY, "r", tokenAssociatedData("u1", "google")) });
    expect(await open(other, google.fetch)).toEqual({ ok: false, reason: "needs_reconnect" });
    expect(other.marked).toHaveLength(1);
    expect(google.calls).toEqual([]);
  });
});

describe("GoogleApiError", () => {
  it("counts only a 4xx as not done", () => {
    expect(new GoogleApiError("rejected", 400).notDone).toBe(true);
    expect(new GoogleApiError("unavailable", 503).notDone).toBe(false);
    expect(new GoogleApiError("timeout", null).notDone).toBe(false);
  });
});

describe("the Google card", () => {
  it("shows each state", () => {
    expect(googleCardState(false, null)).toEqual({ kind: "not_set_up" });
    expect(googleCardState(true, "load_failed")).toEqual({ kind: "load_failed" });
    expect(googleCardState(true, null)).toEqual({ kind: "not_connected" });
    expect(googleCardState(true, { email: "a@example.com", scopes: [], status: "needs_reconnect" })).toEqual({
      kind: "needs_reconnect",
      email: "a@example.com",
    });
    const connected = googleCardState(true, {
      email: "a@example.com",
      scopes: ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/calendar.events.owned"],
      status: "connected",
    });
    expect(connected).toMatchObject({ kind: "connected", email: "a@example.com" });
    expect(connected.kind === "connected" && connected.access).toHaveLength(2);
  });

  it("maps only known outcome codes to a message", () => {
    expect(googleOutcomeMessage("connected")).toEqual({ text: "Google is connected.", error: false });
    expect(googleOutcomeMessage("error")?.error).toBe(true);
    expect(googleOutcomeMessage("<script>")).toBeNull();
    expect(googleOutcomeMessage(["connected"])).toBeNull();
  });
});
