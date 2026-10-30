import { isAuthRetryableFetchError } from "@supabase/supabase-js";

// Shared by the auth server actions and the trial button. The messages never include Supabase's error text.

export const UNAVAILABLE_MESSAGE = "The account service is unavailable right now. Please try again later.";

export function isRateLimit(error: { code?: string; status?: number }): boolean {
  return error.status === 429 || (error.code?.startsWith("over_") ?? false);
}

/** Network failures and Auth server errors are outages, not bad credentials. */
export function isOutage(error: { status?: number }): boolean {
  return isAuthRetryableFetchError(error) || !error.status || error.status >= 500;
}

export const TRIAL_OFF_MESSAGE = "Trying P-Dot without an account is off right now. Create an account or sign in.";

/** The message for a failed `signInAnonymously()`. */
export function trialErrorMessage(error: { code?: string; status?: number }): string {
  // This page sends no CAPTCHA token, so a CAPTCHA requirement means the trial cannot start here.
  if (error.code === "anonymous_provider_disabled" || error.code === "captcha_failed") return TRIAL_OFF_MESSAGE;
  if (isRateLimit(error)) return "Too many trials from this network. Wait a few minutes, or create an account.";
  if (isOutage(error)) return UNAVAILABLE_MESSAGE;
  return "We could not start a trial. Try again, or create an account.";
}
