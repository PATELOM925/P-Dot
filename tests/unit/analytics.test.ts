import { describe, expect, it, vi } from "vitest";
import { accountAnalyticsCookie, captureProductEvent, isAnalyticsAccountEligible, isAnalyticsConfigured, isAnalyticsProductionHost } from "@/server/analytics";
import { accrueVisibleActiveTime, isCurrentConsentStatusResponse, shouldAcquireActiveTimeLock, shouldRetryActiveTimeLock, takeActiveSample } from "@/features/analytics/active-sample";

describe("product analytics", () => {
  it("does not send anything unless production has a project key", async () => {
    const fetchImpl = vi.fn();
    await captureProductEvent("assistant_reply_succeeded", "00000000-0000-4000-8000-000000000000", {}, { NODE_ENV: "production" }, fetchImpl);
    await captureProductEvent("assistant_reply_succeeded", "00000000-0000-4000-8000-000000000000", {}, { NODE_ENV: "development", POSTHOG_PROJECT_TOKEN: "test" }, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the explicit Capture v1 contract with profile processing disabled", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const event = JSON.parse(String(init.body)).batch[0];
      return Response.json({ results: { [event.uuid]: { result: "warning", details: "person_processing_disabled" } } });
    });
    await captureProductEvent(
      "workspace_active_seconds",
      "00000000-0000-4000-8000-000000000000",
      { seconds: 30 },
      { NODE_ENV: "production", POSTHOG_PROJECT_TOKEN: "project-token", POSTHOG_GEOIP_DISABLED: "true", POSTHOG_EXCLUDED_ACCOUNT_IDS: "00000000-0000-4000-8000-000000000001" },
      fetchImpl,
    );
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://us.i.posthog.com/i/v1/analytics/events");
    const payload = JSON.parse(String(init.body));
    expect(payload.created_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(payload.batch).toHaveLength(1);
    expect(payload.batch[0]).toMatchObject({
      event: "workspace_active_seconds",
      distinct_id: "00000000-0000-4000-8000-000000000000",
      properties: { seconds: 30, $geoip_disable: true },
      options: { process_person_profile: false },
    });
    expect(payload.batch[0].uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(init.headers).toMatchObject({ Authorization: "Bearer project-token" });
  });

  it("limits product capture to the production hostname", () => {
    expect(isAnalyticsProductionHost(new Request("https://pdot.iampatelom.com/api/analytics/active"))).toBe(true);
    expect(isAnalyticsProductionHost(new Request("https://preview.workers.dev/api/analytics/active"))).toBe(false);
  });

  it("requires an explicit GeoIP-disabled assertion before analytics is available", () => {
    expect(isAnalyticsConfigured({ NODE_ENV: "production", POSTHOG_PROJECT_TOKEN: "project-token" })).toBe(false);
    expect(isAnalyticsConfigured({ NODE_ENV: "production", POSTHOG_PROJECT_TOKEN: "project-token", POSTHOG_GEOIP_DISABLED: "false" })).toBe(false);
    expect(isAnalyticsConfigured({ NODE_ENV: "production", POSTHOG_PROJECT_TOKEN: "project-token", POSTHOG_GEOIP_DISABLED: "true", POSTHOG_EXCLUDED_ACCOUNT_IDS: "00000000-0000-4000-8000-000000000001" })).toBe(true);
  });

  it("isolates consent and pseudonymous IDs to the verified account", () => {
    const request = new Request("https://pdot.iampatelom.com", {
      headers: { cookie: "pdot_analytics_consent=account-a.yes; pdot_analytics_id=account-a.00000000-0000-4000-8000-000000000000" },
    });
    expect(accountAnalyticsCookie(request, "account-a", "pdot_analytics_consent")).toBe("yes");
    expect(accountAnalyticsCookie(request, "account-b", "pdot_analytics_consent")).toBeUndefined();
    expect(accountAnalyticsCookie(request, "account-b", "pdot_analytics_id")).toBeUndefined();
  });

  it("excludes the configured demo account and explicitly marked smoke requests", async () => {
    const env = { NODE_ENV: "test", POSTHOG_EXCLUDED_ACCOUNT_IDS: "00000000-0000-4000-8000-000000000001" } as NodeJS.ProcessEnv;
    const regular = new Request("https://pdot.iampatelom.com");
    const smoke = new Request("https://pdot.iampatelom.com", { headers: { "x-pdot-smoke-test": "1" } });
    expect(isAnalyticsAccountEligible(regular, "00000000-0000-4000-8000-000000000001", env)).toBe(false);
    expect(isAnalyticsAccountEligible(smoke, "00000000-0000-4000-8000-000000000002", env)).toBe(false);
  });

  it("emits engagement only after 30 active seconds, in a bounded 30-second sample", () => {
    expect(takeActiveSample(29_999)).toBeNull();
    expect(takeActiveSample(30_000)).toEqual({ seconds: 30, remainingMs: 0 });
    expect(takeActiveSample(65_000)).toEqual({ seconds: 30, remainingMs: 35_000 });
  });

  it("counts visible time only after interaction and while the user remains active", () => {
    expect(accrueVisibleActiveTime(0, 15_000, null, 30_000, true)).toBe(0);
    expect(accrueVisibleActiveTime(0, 15_000, 1_000, 20_000, false)).toBe(0);
    expect(accrueVisibleActiveTime(0, 30_000, 1_000, 61_000, true)).toBe(0);
    expect(accrueVisibleActiveTime(0, 30_000, 1_000, 20_000, true)).toBe(15_000);
  });

  it("keeps the visibility listener eligible to reacquire after hide/show", () => {
    const state = { enabled: true, visible: false, disposed: false, hasController: false };
    expect(shouldAcquireActiveTimeLock(state)).toBe(false);
    state.visible = true;
    expect(shouldAcquireActiveTimeLock(state)).toBe(true);
  });

  it("retries after an ifAvailable lock miss but not after acquisition or opt-out", () => {
    expect(shouldRetryActiveTimeLock({ acquired: false, enabled: true, visible: true, disposed: false })).toBe(true);
    expect(shouldRetryActiveTimeLock({ acquired: true, enabled: true, visible: true, disposed: false })).toBe(false);
    expect(shouldRetryActiveTimeLock({ acquired: false, enabled: false, visible: true, disposed: false })).toBe(false);
  });

  it("ignores a status response made stale by a consent change or unmount", () => {
    expect(isCurrentConsentStatusResponse(0, 0, false)).toBe(true);
    expect(isCurrentConsentStatusResponse(0, 1, false)).toBe(false);
    expect(isCurrentConsentStatusResponse(0, 0, true)).toBe(false);
  });

  it("does not hide a rejected Capture v1 event in a 200 batch response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const event = JSON.parse(String(init.body)).batch[0];
      return Response.json({ results: { [event.uuid]: { result: "drop", details: "invalid_event_timestamp" } } });
    });
    await captureProductEvent("assistant_reply_succeeded", "00000000-0000-4000-8000-000000000000", {}, { NODE_ENV: "production", POSTHOG_PROJECT_TOKEN: "project-token", POSTHOG_GEOIP_DISABLED: "true", POSTHOG_EXCLUDED_ACCOUNT_IDS: "00000000-0000-4000-8000-000000000001" }, fetchImpl);
    expect(warn).toHaveBeenCalledWith("product_analytics_event_rejected", { result: "drop", details: "invalid_event_timestamp" });
    warn.mockRestore();
  });

  it("reports non-2xx delivery without exposing event data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    await captureProductEvent("assistant_reply_succeeded", "00000000-0000-4000-8000-000000000000", { secret: "never-log" }, { NODE_ENV: "production", POSTHOG_PROJECT_TOKEN: "project-token", POSTHOG_GEOIP_DISABLED: "true", POSTHOG_EXCLUDED_ACCOUNT_IDS: "00000000-0000-4000-8000-000000000001" }, fetchImpl);
    expect(warn).toHaveBeenCalledWith("product_analytics_delivery_failed", { status: 401 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("never-log");
    warn.mockRestore();
  });
});
