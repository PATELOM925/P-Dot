import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

class Redirect extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Redirect(url);
  }),
}));
vi.mock("@/server/db/supabase", () => ({ createSupabaseServerClient: vi.fn() }));

const { createSupabaseServerClient } = await import("@/server/db/supabase");
const { signInWithGoogleAction } = await import("@/features/auth/actions");
const callbackRoute = await import("@/app/auth/callback/route");
const { updateSession } = await import("@/server/auth/proxy-session");

const signInWithOAuth = vi.fn();
const exchangeCodeForSession = vi.fn();

beforeEach(() => {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: { signInWithOAuth, exchangeCodeForSession },
  } as never);
  vi.stubEnv("SITE_URL", "https://pdot.iampatelom.com");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  signInWithOAuth.mockReset();
  exchangeCodeForSession.mockReset();
});

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Redirect) return error.url;
    throw error;
  }
  throw new Error("no redirect");
}

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

describe("Continue with Google", () => {
  it("asks Supabase for the Google URL with our callback and a safe next path, and passes no extra scopes", async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }, error: null });
    expect(await redirectOf(() => signInWithGoogleAction(form({ next: "/memory" })))).toBe("https://accounts.google.com/o/oauth2/v2/auth?x=1");
    const options = signInWithOAuth.mock.calls[0]![0];
    expect(options.provider).toBe("google");
    expect(options.options.redirectTo).toBe("https://pdot.iampatelom.com/auth/callback?next=%2Fmemory");
    expect(options.options.scopes).toBeUndefined();
  });

  it("replaces an unsafe next path", async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: "https://accounts.google.com/x" }, error: null });
    await redirectOf(() => signInWithGoogleAction(form({ next: "https://evil.example" })));
    expect(signInWithOAuth.mock.calls[0]![0].options.redirectTo).toBe("https://pdot.iampatelom.com/auth/callback?next=%2Fchat");
  });

  it.each([
    ["an error", { data: { url: null }, error: { message: "provider disabled" } }],
    ["a URL that is not https", { data: { url: "javascript:alert(1)" }, error: null }],
  ])("goes to the one login message on %s", async (_name, answer) => {
    signInWithOAuth.mockResolvedValue(answer);
    expect(await redirectOf(() => signInWithGoogleAction(form({})))).toBe("/login?error=oauth");
  });
});

describe("GET /auth/callback", () => {
  const get = (query: string) => callbackRoute.GET(new NextRequest(`http://localhost/auth/callback${query}`));

  it("exchanges the code and goes to the next path", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const response = await get("?code=abc&next=%2Fmemory");
    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(response.headers.get("location")).toBe("http://localhost/memory");
  });

  it.each([
    ["no code", "?next=%2Fchat"],
    ["a Google error", "?error=access_denied&code=abc"],
  ])("sends %s to the one login message without an exchange", async (_name, query) => {
    const response = await get(query);
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("http://localhost/login?error=oauth");
  });

  it("gives the same message for every failed exchange, so it does not show whether an account exists", async () => {
    const answers = [
      { error: { code: "user_banned", message: "User is banned" } },
      { error: { code: "bad_code_verifier", message: "invalid" } },
      { error: { code: "email_exists", message: "exists" } },
    ];
    const locations = new Set<string>();
    for (const answer of answers) {
      exchangeCodeForSession.mockResolvedValueOnce(answer);
      locations.add((await get("?code=abc")).headers.get("location")!);
    }
    expect([...locations]).toEqual(["http://localhost/login?error=oauth"]);
  });

  it("refuses an off-site next path", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    expect((await get("?code=abc&next=%2F%2Fevil.example")).headers.get("location")).toBe("http://localhost/chat");
  });
});

describe("the proxy lets /auth/callback through", () => {
  it("does not redirect a signed-out browser away from /auth/callback", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({}), { status: 401 }));
    try {
      const response = await updateSession(new NextRequest("http://localhost/auth/callback?code=abc"));
      expect(response.headers.get("location")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
