import { isOutage, isRateLimit, trialErrorMessage, UNAVAILABLE_MESSAGE } from "./errors";

interface AuthErrorLike {
  code?: string;
  status?: number;
}

/** The part of the Supabase browser client that a trial start uses. */
export interface TrialAuthClient {
  getUser(): Promise<{ data: { user: unknown }; error: AuthErrorLike | null }>;
  signInAnonymously(): Promise<{ error: AuthErrorLike | null }>;
}

export type TrialStart = { ok: true } | { ok: false; message: string };

/**
 * Reuses a valid session, or makes one anonymous user. A rate limit or an
 * outage on the session check stops here, so a current trial is never replaced
 * because the check failed. Only "no session" or a session the Auth server
 * rejects (a deleted user, an expired token) leads to a new trial.
 */
export async function startTrial(client: TrialAuthClient): Promise<TrialStart> {
  const { data, error: userError } = await client.getUser();
  if (userError && isRateLimit(userError)) return { ok: false, message: trialErrorMessage(userError) };
  if (userError && isOutage(userError)) return { ok: false, message: UNAVAILABLE_MESSAGE };
  if (data.user) return { ok: true };
  const { error } = await client.signInAnonymously();
  return error ? { ok: false, message: trialErrorMessage(error) } : { ok: true };
}
