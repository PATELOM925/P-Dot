import "server-only";
import { NextResponse } from "next/server";
import type { TelegramOutcome } from "@/lib/telegram";
import { getTelegramConfig, type TelegramConfig } from "@/server/config";
import { logEvent } from "@/server/log";

// Shared by the Telegram routes (decision 0020).

/** The config, or null after logging the names of bad variables (never values). */
export function readyTelegramConfig(requestId: string, route: string): TelegramConfig | null {
  const state = getTelegramConfig();
  if (state.status === "ready") return state.config;
  if (state.invalid.length > 0) logEvent("error", "telegram_config_invalid", { requestId, route, names: state.invalid.join(",") });
  return null;
}

/** A 303 back to the Telegram card with a short outcome code that carries no data. */
export function backToTelegramCard(request: Request, outcome: TelegramOutcome): NextResponse {
  return NextResponse.redirect(new URL(`/connectors?telegram=${outcome}#telegram`, request.url), 303);
}

/** Calls Telegram with the global fetch at call time, so tests can replace it. */
export const telegramFetch = (input: string, init?: RequestInit) => fetch(input, init);
