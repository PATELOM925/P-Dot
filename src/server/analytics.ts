import "server-only";

const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/i/v1/analytics/events";
const PRODUCTION_HOST = "pdot.iampatelom.com";

export type ProductEvent = "account_analytics_started" | "assistant_reply_succeeded" | "connector_read_succeeded" | "workspace_active_seconds";

export function isAnalyticsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const excluded = (env.POSTHOG_EXCLUDED_ACCOUNT_IDS ?? "").split(",").map((value) => value.trim());
  return env.NODE_ENV === "production" && Boolean(env.POSTHOG_PROJECT_TOKEN?.trim()) && env.POSTHOG_GEOIP_DISABLED === "true" && excluded.some((id) => /^[0-9a-f-]{36}$/i.test(id));
}

export function isAnalyticsAccountEligible(request: Request, accountId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const excluded = (env.POSTHOG_EXCLUDED_ACCOUNT_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return request.headers.get("x-pdot-smoke-test") !== "1" && !excluded.includes(accountId);
}

function uuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const time = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) bytes[5 - index] = Number((time >> BigInt(index * 8)) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function captureProductEvent(
  event: ProductEvent,
  distinctId: string,
  properties: Record<string, string | number>,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!isAnalyticsConfigured(env) || !/^[0-9a-f-]{36}$/i.test(distinctId)) return;
  try {
    const eventUuid = uuidV7();
    const response = await fetchImpl(POSTHOG_CAPTURE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.POSTHOG_PROJECT_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "P-Dot/1.0",
        "PostHog-Sdk-Info": "pdot-explicit-capture/1.0",
        "PostHog-Request-Id": crypto.randomUUID(),
        "PostHog-Attempt": "1",
        "PostHog-Request-Timestamp": new Date().toISOString(),
      },
      body: JSON.stringify({
        created_at: new Date().toISOString(),
        batch: [{
          uuid: eventUuid,
          event,
          distinct_id: distinctId,
          timestamp: new Date().toISOString(),
          properties: { ...properties, $geoip_disable: true },
          options: { process_person_profile: false },
        }],
      }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) console.warn("product_analytics_delivery_failed", { status: response.status });
    else {
      const result: unknown = await response.json().catch(() => null);
      const eventResult = result && typeof result === "object" && "results" in result && result.results && typeof result.results === "object"
        ? (result.results as Record<string, { result?: unknown; details?: unknown }>)[eventUuid]
        : undefined;
      if (!eventResult || !["ok", "warning"].includes(String(eventResult.result))) {
        const details = typeof eventResult?.details === "string" ? eventResult.details.slice(0, 80) : "missing_event_result";
        console.warn("product_analytics_event_rejected", { result: String(eventResult?.result ?? "missing"), details });
      }
    }
  } catch {
    console.warn("product_analytics_delivery_failed", { status: "network_or_timeout" });
  }
}

export function isAnalyticsProductionHost(request: Request): boolean {
  try {
    return new URL(request.url).hostname.toLowerCase() === PRODUCTION_HOST;
  } catch {
    return false;
  }
}

export function accountAnalyticsCookie(request: Request, accountId: string, key: "pdot_analytics_consent" | "pdot_analytics_id"): string | undefined {
  const value = cookieValue(request, key);
  if (!value) return undefined;
  const [boundAccount, stored] = value.split(".", 2);
  return boundAccount === accountId ? stored : undefined;
}

export function cookieValue(request: Request, name: string): string | undefined {
  return request.headers.get("cookie")?.split(";").map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
}
