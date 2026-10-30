import { describe, expect, it, vi } from "vitest";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";
import { TRIAL_OFF_MESSAGE, UNAVAILABLE_MESSAGE, trialErrorMessage } from "@/features/auth/errors";
import { startTrial } from "@/features/auth/start-trial";

vi.mock("@/server/db/supabase", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const { createSupabaseServerClient } = await import("@/server/db/supabase");
const { updatePasswordAction } = await import("@/features/auth/actions");

describe("trialErrorMessage", () => {
  it("says the trial is off when anonymous sign-ins are disabled", () => {
    expect(trialErrorMessage(new AuthApiError("Anonymous sign-ins are disabled", 422, "anonymous_provider_disabled"))).toBe(
      TRIAL_OFF_MESSAGE,
    );
  });

  it("treats a CAPTCHA requirement as off, because this page sends no token", () => {
    expect(trialErrorMessage(new AuthApiError("captcha protection", 400, "captcha_failed"))).toBe(TRIAL_OFF_MESSAGE);
  });

  it("maps the per-IP limit to a wait message", () => {
    const message = trialErrorMessage(new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"));
    expect(message).toMatch(/^Too many trials/);
  });

  it("maps network errors and server errors to unavailable", () => {
    expect(trialErrorMessage(new AuthRetryableFetchError("fetch failed", 0))).toBe(UNAVAILABLE_MESSAGE);
    expect(trialErrorMessage(new AuthApiError("boom", 500, "unexpected_failure"))).toBe(UNAVAILABLE_MESSAGE);
  });

  it("never shows Supabase's own text for other errors", () => {
    const message = trialErrorMessage(new AuthApiError("secret detail", 400, "validation_failed"));
    expect(message).toBe("We could not start a trial. Try again, or create an account.");
  });
});

describe("startTrial", () => {
  function client(getUser: { user: unknown; error: unknown }, signInError: unknown = null) {
    return {
      getUser: vi.fn(async () => ({ data: { user: getUser.user }, error: getUser.error as never })),
      signInAnonymously: vi.fn(async () => ({ error: signInError as never })),
    };
  }

  it("keeps the current trial when the session check hits the rate limit", async () => {
    const c = client({ user: null, error: new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit") });
    const result = await startTrial(c);
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/^Too many trials/) });
    expect(c.signInAnonymously).not.toHaveBeenCalled();
  });

  it("keeps the current trial when the session check cannot reach Auth", async () => {
    for (const error of [new AuthRetryableFetchError("fetch failed", 0), new AuthApiError("boom", 502, "unexpected_failure")]) {
      const c = client({ user: null, error });
      expect(await startTrial(c)).toEqual({ ok: false, message: UNAVAILABLE_MESSAGE });
      expect(c.signInAnonymously).not.toHaveBeenCalled();
    }
  });

  it("reuses a valid session and makes no user", async () => {
    const c = client({ user: { id: "u1" }, error: null });
    expect(await startTrial(c)).toEqual({ ok: true });
    expect(c.signInAnonymously).not.toHaveBeenCalled();
  });

  it("makes one trial when there is no session, or the Auth server rejects the old one", async () => {
    for (const error of [new AuthSessionMissingError(), new AuthApiError("invalid JWT", 403, "bad_jwt")]) {
      const c = client({ user: null, error });
      expect(await startTrial(c)).toEqual({ ok: true });
      expect(c.signInAnonymously).toHaveBeenCalledTimes(1);
    }
  });

  it("reports a failed sign-in and does not succeed", async () => {
    const c = client(
      { user: null, error: new AuthSessionMissingError() },
      new AuthApiError("Anonymous sign-ins are disabled", 422, "anonymous_provider_disabled"),
    );
    expect(await startTrial(c)).toEqual({ ok: false, message: TRIAL_OFF_MESSAGE });
  });
});

describe("updatePasswordAction", () => {
  function form(password: string) {
    const data = new FormData();
    data.set("password", password);
    data.set("confirm", password);
    return data;
  }

  it("refuses a trial user before it calls updateUser", async () => {
    const updateUser = vi.fn();
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: {
        getClaims: async () => ({ data: { claims: { sub: "u1", email: "", is_anonymous: true } }, error: null }),
        updateUser,
      },
    } as never);
    expect(await updatePasswordAction({}, form("a-long-password"))).toEqual({
      error: "A trial has no password. Create an account first.",
    });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("still updates the password of an account", async () => {
    const updateUser = vi.fn(async () => ({ data: {}, error: null }));
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: {
        getClaims: async () => ({ data: { claims: { sub: "u1", email: "a@example.com", is_anonymous: false } }, error: null }),
        updateUser,
      },
    } as never);
    await updatePasswordAction({}, form("a-long-password"));
    expect(updateUser).toHaveBeenCalledWith({ password: "a-long-password" });
  });
});
