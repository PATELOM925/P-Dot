import { describe, expect, it, vi } from "vitest";
import { captureProductEvent, isAnalyticsProductionHost } from "@/server/analytics";

describe("product analytics", () => {
  it("does not send anything unless production has a project key", async () => {
    const fetchImpl = vi.fn();
    await captureProductEvent("assistant_reply_succeeded", "00000000-0000-4000-8000-000000000000", {}, { NODE_ENV: "production" }, fetchImpl);
    await captureProductEvent("assistant_reply_succeeded", "00000000-0000-4000-8000-000000000000", {}, { NODE_ENV: "development", POSTHOG_PROJECT_TOKEN: "test" }, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends only the explicit event payload and disables IP enrichment", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await captureProductEvent(
      "workspace_active_seconds",
      "00000000-0000-4000-8000-000000000000",
      { seconds: 30 },
      { NODE_ENV: "production", POSTHOG_PROJECT_TOKEN: "project-token" },
      fetchImpl,
    );
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://us.i.posthog.com/i/v1/analytics/events");
    const payload = JSON.parse(String(init.body));
    expect(payload.batch).toHaveLength(1);
    expect(payload.batch[0]).toMatchObject({
      event: "workspace_active_seconds",
      distinct_id: "00000000-0000-4000-8000-000000000000",
      properties: { seconds: 30 },
      options: { process_person_profile: false },
    });
    expect(payload.batch[0].uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(init.headers).toMatchObject({ Authorization: "Bearer project-token" });
  });

  it("limits product capture to the production hostname", () => {
    expect(isAnalyticsProductionHost(new Request("https://pdot.iampatelom.com/api/analytics/active"))).toBe(true);
    expect(isAnalyticsProductionHost(new Request("https://preview.workers.dev/api/analytics/active"))).toBe(false);
  });
});
