import "server-only";
import { hasAccount } from "@/lib/auth-identity";
import type { AssistantConfig } from "@/server/config";

/**
 * Lower per-user limits for a trial user (decision 0015). They are for fair
 * use, not an abuse limit: a person can start many trials. The global caps
 * and the worst-case hold do not change. Each value is the lower of the
 * account limit and the trial limit.
 */
export const TRIAL_LIMITS = {
  requestsPerWindow: 20,
  nebiusUserDayMicroUsd: 150_000, // $0.15
  tavilyUserDayCredits: 5,
} as const;

export type UserLimits = Pick<AssistantConfig, "quota" | "spend">;

/** The limits for this user. A context without a verified account flag gets the trial limits. */
export function limitsFor(auth: { isAnonymous?: boolean }, config: UserLimits): UserLimits {
  if (hasAccount(auth)) return { quota: config.quota, spend: config.spend };
  return {
    quota: {
      ...config.quota,
      requestsPerWindow: Math.min(config.quota.requestsPerWindow, TRIAL_LIMITS.requestsPerWindow),
    },
    spend: {
      nebius: {
        ...config.spend.nebius,
        userDay: Math.min(config.spend.nebius.userDay, TRIAL_LIMITS.nebiusUserDayMicroUsd),
      },
      tavily: {
        ...config.spend.tavily,
        userDay: Math.min(config.spend.tavily.userDay, TRIAL_LIMITS.tavilyUserDayCredits),
      },
    },
  };
}
