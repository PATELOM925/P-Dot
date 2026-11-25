import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: "00000000-0000-4000-8000-000000000002", isAnonymous: false }));
vi.mock("@/server/auth/session", () => ({ getAuthContext: async () => ({ ...session }) }));
vi.mock("@/server/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/analytics")>();
  return { ...actual, captureProductEvent: vi.fn() };
});

import { POST as consentPost } from "@/app/api/analytics/consent/route";
import { POST as activePost } from "@/app/api/analytics/active/route";
import { GET as statusGet } from "@/app/api/analytics/status/route";

const accountId = "00000000-0000-4000-8000-000000000002";
const excludedDemoId = "00000000-0000-4000-8000-000000000001";
const hostHeaders = { host: "pdot.iampatelom.com", origin: "https://pdot.iampatelom.com", "content-type": "application/json" };

function request(url: string, body?: unknown, cookie?: string, extraHeaders: Record<string, string> = {}) {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...hostHeaders, ...(cookie ? { cookie } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("analytics API opt-in boundaries", () => {
  beforeEach(() => {
    session.userId = accountId;
    session.isAnonymous = false;
    vi.stubEnv("NODE_ENV", "production");
    process.env.POSTHOG_PROJECT_TOKEN = "fake-project-token";
    process.env.POSTHOG_GEOIP_DISABLED = "true";
    process.env.POSTHOG_EXCLUDED_ACCOUNT_IDS = excludedDemoId;
  });

  afterEach(() => vi.unstubAllEnvs());

  it("binds consent to the current account, then clears both cookies on opt-out", async () => {
    const enabled = await consentPost(request("https://pdot.iampatelom.com/api/analytics/consent", { enabled: true }));
    const cookies = enabled.headers.getSetCookie();
    expect(cookies[0]).toContain(`${accountId}.yes`);
    expect(cookies[1]).toMatch(new RegExp(`pdot_analytics_id=${accountId}\\.[0-9a-f-]{36}`));
    const bundled = cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");

    session.userId = "00000000-0000-4000-8000-000000000003";
    const switched = await statusGet(request("https://pdot.iampatelom.com/api/analytics/status", undefined, bundled));
    expect(await switched.json()).toMatchObject({ available: true, enabled: false });

    session.userId = accountId;
    const optedOut = await consentPost(request("https://pdot.iampatelom.com/api/analytics/consent", { enabled: false }, bundled));
    expect(optedOut.headers.getSetCookie()).toEqual(expect.arrayContaining([
      expect.stringContaining("pdot_analytics_consent=; Path=/; Max-Age=0"),
      expect.stringContaining("pdot_analytics_id=; Path=/; Max-Age=0"),
    ]));
  });

  it("refuses demo and unconsented activity and bounds screen payloads", async () => {
    const noConsent = await activePost(request("https://pdot.iampatelom.com/api/analytics/active", { seconds: 30, screen: "chat" }));
    expect(noConsent.status).toBe(404);

    session.userId = excludedDemoId;
    const demo = await activePost(request("https://pdot.iampatelom.com/api/analytics/active", { seconds: 30, screen: "chat" }, `pdot_analytics_consent=${excludedDemoId}.yes`));
    expect(demo.status).toBe(404);

    session.userId = accountId;
    const optOut = await activePost(request("https://pdot.iampatelom.com/api/analytics/active", { seconds: 30, screen: "chat" }, `pdot_analytics_consent=${accountId}.no`));
    expect(optOut.status).toBe(404);
    const oversized = await activePost(request("https://pdot.iampatelom.com/api/analytics/active", { seconds: 31, screen: "chat" }, `pdot_analytics_consent=${accountId}.yes; pdot_analytics_id=${accountId}.00000000-0000-4000-8000-000000000099`));
    expect(oversized.status).toBe(400);
    const invalidScreen = await activePost(request("https://pdot.iampatelom.com/api/analytics/active", { seconds: 30, screen: "/chat/private-path" }, `pdot_analytics_consent=${accountId}.yes`));
    expect(invalidScreen.status).toBe(400);
  });
});
