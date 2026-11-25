import "server-only";

const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/i/v1/analytics/events";
const PRODUCTION_HOST = "pdot.iampatelom.com";

export type ProductEvent = "assistant_reply_succeeded" | "workspace_active_seconds";

function analyticsEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" && Boolean(env.POSTHOG_PROJECT_TOKEN?.trim());
}

function uuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const time = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) bytes[5 - index] = Number((time >> BigInt(index * 8)) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
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
  if (!analyticsEnabled(env) || !/^[0-9a-f-]{36}$/i.test(distinctId)) return;
  try {
    await fetchImpl(POSTHOG_CAPTURE_URL, {
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
        batch: [{
          uuid: uuidV7(),
          event,
          distinct_id: distinctId,
          timestamp: new Date().toISOString(),
          properties,
          options: { process_person_profile: false },
        }],
      }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Analytics must not affect the user request.
  }
}

export function isAnalyticsProductionHost(request: Request): boolean {
  return request.headers.get("host")?.split(":", 1)[0]?.toLowerCase() === PRODUCTION_HOST;
}

export function cookieValue(request: Request, name: string): string | undefined {
  return request.headers.get("cookie")?.split(";").map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
}
