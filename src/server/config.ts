import "server-only";
import { z } from "zod";
import { ConfigError } from "@/lib/supabase-config";
import type { SpendCaps, SpendProvider } from "@/server/db/spend";

// Server-only configuration. Values are read per call (not at import time) so
// `next build` works without secrets and misconfiguration fails the request
// that needs it with a clear, secret-free error.

export interface AssistantConfig {
  nebius: {
    apiKey: string;
    baseUrl: string;
    model: string;
    maxOutputTokens: number;
  };
  /** Null when TAVILY_API_KEY is not set; search requests then report failure. */
  tavily: { apiKey: string } | null;
  quota: {
    requestsPerWindow: number;
    windowSeconds: number;
  };
  /**
   * Global spend caps, shared by all users. Nebius: micro-dollars, day and all-time.
   * Tavily: credits, day and calendar month (UTC).
   */
  spend: Record<SpendProvider, SpendCaps>;
}

const MICRO_USD_PER_USD = 1_000_000;

// The bounds match the hard limits in the reserve_provider_spend database function.
const usd = (min: number, max: number, fallback: number) => z.coerce.number().min(min).max(max).default(fallback);
const credits = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);

const assistantEnvSchema = z.object({
  NEBIUS_API_KEY: z.string().trim().min(1),
  NEBIUS_BASE_URL: z.url().default("https://api.tokenfactory.nebius.com/v1"),
  NEBIUS_MODEL: z.string().trim().min(1),
  NEBIUS_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(8192).default(1024),
  TAVILY_API_KEY: z.string().trim().optional(),
  CHAT_REQUESTS_PER_WINDOW: z.coerce.number().int().min(1).max(10_000).default(30),
  CHAT_WINDOW_SECONDS: z.coerce.number().int().min(60).max(2_678_400).default(3600),
  NEBIUS_DAILY_CAP_USD: usd(0.01, 100, 1),
  NEBIUS_TOTAL_CAP_USD: usd(0.01, 1000, 20),
  NEBIUS_USER_DAILY_CAP_USD: usd(0.01, 0.5, 0.25),
  TAVILY_DAILY_CREDITS: credits(1000, 40),
  TAVILY_MONTHLY_CREDITS: credits(20_000, 800),
  TAVILY_USER_DAILY_CREDITS: credits(20, 10),
});

const SPEND_ENV_NAMES = [
  "NEBIUS_DAILY_CAP_USD",
  "NEBIUS_TOTAL_CAP_USD",
  "NEBIUS_USER_DAILY_CAP_USD",
  "TAVILY_DAILY_CREDITS",
  "TAVILY_MONTHLY_CREDITS",
  "TAVILY_USER_DAILY_CREDITS",
] as const;

function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function getAssistantConfig(env: NodeJS.ProcessEnv = process.env): AssistantConfig {
  const parsed = assistantEnvSchema.safeParse({
    NEBIUS_API_KEY: env.NEBIUS_API_KEY,
    NEBIUS_BASE_URL: blankToUndefined(env.NEBIUS_BASE_URL),
    NEBIUS_MODEL: env.NEBIUS_MODEL,
    NEBIUS_MAX_OUTPUT_TOKENS: blankToUndefined(env.NEBIUS_MAX_OUTPUT_TOKENS),
    TAVILY_API_KEY: blankToUndefined(env.TAVILY_API_KEY),
    CHAT_REQUESTS_PER_WINDOW: blankToUndefined(env.CHAT_REQUESTS_PER_WINDOW),
    CHAT_WINDOW_SECONDS: blankToUndefined(env.CHAT_WINDOW_SECONDS),
    ...Object.fromEntries(SPEND_ENV_NAMES.map((name) => [name, blankToUndefined(env[name])])),
  });
  if (!parsed.success) {
    // Report variable names only, never values.
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new ConfigError(names);
  }
  const e = parsed.data;
  return {
    nebius: {
      apiKey: e.NEBIUS_API_KEY,
      baseUrl: e.NEBIUS_BASE_URL.replace(/\/+$/, ""),
      model: e.NEBIUS_MODEL,
      maxOutputTokens: e.NEBIUS_MAX_OUTPUT_TOKENS,
    },
    tavily: e.TAVILY_API_KEY ? { apiKey: e.TAVILY_API_KEY } : null,
    quota: {
      requestsPerWindow: e.CHAT_REQUESTS_PER_WINDOW,
      windowSeconds: e.CHAT_WINDOW_SECONDS,
    },
    spend: {
      nebius: spendCaps(
        Math.round(e.NEBIUS_DAILY_CAP_USD * MICRO_USD_PER_USD),
        Math.round(e.NEBIUS_TOTAL_CAP_USD * MICRO_USD_PER_USD),
        Math.round(e.NEBIUS_USER_DAILY_CAP_USD * MICRO_USD_PER_USD),
      ),
      tavily: spendCaps(e.TAVILY_DAILY_CREDITS, e.TAVILY_MONTHLY_CREDITS, e.TAVILY_USER_DAILY_CREDITS),
    },
  };
}

/** The per-user cap can never be more than the cap for all users. */
function spendCaps(day: number, period: number, userDay: number): SpendCaps {
  return { day, period, userDay: Math.min(userDay, day) };
}

/** Public base URL used in auth emails (verification and password recovery). */
export function getSiteUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = blankToUndefined(env.SITE_URL);
  if (explicit) return explicit.replace(/\/+$/, "");
  return "http://localhost:3000";
}
