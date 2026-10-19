import "server-only";
import { z } from "zod";
import { ConfigError } from "@/lib/supabase-config";

// Server-only configuration. Values are read per call (not at import time) so
// `next build` works without secrets and misconfiguration fails the request
// that needs it with a clear, secret-free error.

export interface AssistantConfig {
  nebius: {
    apiKey: string;
    baseUrl: string;
    model: string;
    fallbackModel?: string;
    maxOutputTokens: number;
  };
  /** Null when TAVILY_API_KEY is not set; search requests then report failure. */
  tavily: { apiKey: string } | null;
  quota: {
    requestsPerWindow: number;
    windowSeconds: number;
  };
}

const assistantEnvSchema = z.object({
  NEBIUS_API_KEY: z.string().trim().min(1),
  NEBIUS_BASE_URL: z.url().default("https://api.tokenfactory.nebius.com/v1"),
  NEBIUS_MODEL: z.string().trim().min(1),
  NEBIUS_FALLBACK_MODEL: z.string().trim().optional(),
  NEBIUS_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(8192).default(1024),
  TAVILY_API_KEY: z.string().trim().optional(),
  CHAT_REQUESTS_PER_WINDOW: z.coerce.number().int().min(1).max(10_000).default(30),
  CHAT_WINDOW_SECONDS: z.coerce.number().int().min(60).max(2_678_400).default(3600),
});

function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function getAssistantConfig(env: NodeJS.ProcessEnv = process.env): AssistantConfig {
  const parsed = assistantEnvSchema.safeParse({
    NEBIUS_API_KEY: env.NEBIUS_API_KEY,
    NEBIUS_BASE_URL: blankToUndefined(env.NEBIUS_BASE_URL),
    NEBIUS_MODEL: env.NEBIUS_MODEL,
    NEBIUS_FALLBACK_MODEL: blankToUndefined(env.NEBIUS_FALLBACK_MODEL),
    NEBIUS_MAX_OUTPUT_TOKENS: blankToUndefined(env.NEBIUS_MAX_OUTPUT_TOKENS),
    TAVILY_API_KEY: blankToUndefined(env.TAVILY_API_KEY),
    CHAT_REQUESTS_PER_WINDOW: blankToUndefined(env.CHAT_REQUESTS_PER_WINDOW),
    CHAT_WINDOW_SECONDS: blankToUndefined(env.CHAT_WINDOW_SECONDS),
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
      fallbackModel: e.NEBIUS_FALLBACK_MODEL,
      maxOutputTokens: e.NEBIUS_MAX_OUTPUT_TOKENS,
    },
    tavily: e.TAVILY_API_KEY ? { apiKey: e.TAVILY_API_KEY } : null,
    quota: {
      requestsPerWindow: e.CHAT_REQUESTS_PER_WINDOW,
      windowSeconds: e.CHAT_WINDOW_SECONDS,
    },
  };
}

/** Public base URL used in auth emails (verification and password recovery). */
export function getSiteUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = blankToUndefined(env.SITE_URL);
  if (explicit) return explicit.replace(/\/+$/, "");
  return "http://localhost:3000";
}
