import { describe, expect, it, vi } from "vitest";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { TRIAL_OFF_MESSAGE, UNAVAILABLE_MESSAGE, trialErrorMessage } from "@/features/auth/errors";

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
