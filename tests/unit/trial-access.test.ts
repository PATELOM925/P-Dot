import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { hasAccount, readIdentity } from "@/lib/auth-identity";
import type { AuthContext } from "@/server/auth/session";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));

const { getAuthContext } = await import("@/server/auth/session");
const { createServerClient } = await import("@supabase/ssr");
const { withAuthenticatedRoute } = await import("@/server/http/route");
const { updateSession } = await import("@/server/auth/proxy-session");

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// Claim shapes as Supabase Auth issues them. An anonymous user has `is_anonymous: true` and an empty email.
const ANONYMOUS_CLAIMS = { sub: USER, role: "authenticated", aud: "authenticated", email: "", phone: "", is_anonymous: true };
const ACCOUNT_CLAIMS = { sub: USER, role: "authenticated", aud: "authenticated", email: "a@example.com", is_anonymous: false };

describe("readIdentity", () => {
  it("reads a trial user with an empty email as anonymous with no email", () => {
    expect(readIdentity(ANONYMOUS_CLAIMS)).toEqual({ userId: USER, email: null, isAnonymous: true });
  });

  it("reads a trial user with no email claim", () => {
    expect(readIdentity({ sub: USER, is_anonymous: true })).toEqual({ userId: USER, email: null, isAnonymous: true });
  });

  it("reads an account", () => {
    expect(readIdentity(ACCOUNT_CLAIMS)).toEqual({ userId: USER, email: "a@example.com", isAnonymous: false });
  });

  it("reads a token without is_anonymous as an account", () => {
    expect(readIdentity({ sub: USER, email: "a@example.com" })?.isAnonymous).toBe(false);
  });

  it("refuses a token without a subject, and a non-string email is no email", () => {
    expect(readIdentity({ email: "a@example.com" })).toBeNull();
    expect(readIdentity({ sub: "" })).toBeNull();
    expect(readIdentity(null)).toBeNull();
    expect(readIdentity({ sub: USER, email: 42 })?.email).toBeNull();
  });
});

describe("hasAccount", () => {
  it("is true only when isAnonymous is false", () => {
    expect(hasAccount({ isAnonymous: false })).toBe(true);
    expect(hasAccount({ isAnonymous: true })).toBe(false);
    expect(hasAccount({})).toBe(false);
  });
});

describe("withAuthenticatedRoute requireAccount", () => {
  const request = () => new Request("http://localhost/api/x", { method: "POST" });

  function signInAs(isAnonymous: boolean | undefined) {
    vi.mocked(getAuthContext).mockResolvedValue({
      userId: USER,
      email: null,
      ...(isAnonymous === undefined ? {} : { isAnonymous }),
      supabase: {} as SupabaseClient,
    } satisfies AuthContext);
  }

  it("refuses a trial user with 403 account_required and does not run the handler", async () => {
    signInAs(true);
    const handler = vi.fn(async () => new Response("ran"));
    const response = await withAuthenticatedRoute(request(), { route: "t", requireAccount: true }, handler);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("account_required");
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed for a context without isAnonymous", async () => {
    signInAs(undefined);
    const handler = vi.fn(async () => new Response("ran"));
    const response = await withAuthenticatedRoute(request(), { route: "t", requireAccount: true }, handler);
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the handler for an account", async () => {
    signInAs(false);
    const response = await withAuthenticatedRoute(request(), { route: "t", requireAccount: true }, async () => new Response("ran"));
    expect(await response.text()).toBe("ran");
  });

  it("lets a trial user through a route without the option", async () => {
    signInAs(true);
    const response = await withAuthenticatedRoute(request(), { route: "t" }, async () => new Response("ran"));
    expect(await response.text()).toBe("ran");
  });
});

describe("proxy redirects", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  });
  afterEach(() => vi.unstubAllEnvs());

  function withClaims(claims: object | null) {
    vi.mocked(createServerClient).mockReturnValue({
      auth: { getClaims: async () => ({ data: claims ? { claims } : null, error: null }) },
    } as unknown as ReturnType<typeof createServerClient>);
  }
  const visit = (path: string) => updateSession(new NextRequest(`http://localhost${path}`));

  it("lets a trial user open the sign-up and sign-in pages", async () => {
    withClaims(ANONYMOUS_CLAIMS);
    expect((await visit("/signup")).headers.get("location")).toBeNull();
    expect((await visit("/login")).headers.get("location")).toBeNull();
  });

  it("lets a trial user open workspace pages", async () => {
    withClaims(ANONYMOUS_CLAIMS);
    expect((await visit("/chat")).headers.get("location")).toBeNull();
  });

  it("sends an account away from the sign-up page", async () => {
    withClaims(ACCOUNT_CLAIMS);
    expect(new URL((await visit("/signup")).headers.get("location")!).pathname).toBe("/chat");
  });

  it("sends a signed-out visitor to the login page", async () => {
    withClaims(null);
    expect(new URL((await visit("/chat")).headers.get("location")!).pathname).toBe("/login");
  });
});
