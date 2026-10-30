import { describe, expect, it } from "vitest";
import { config } from "@/proxy";

// Next.js tests the matcher against the whole path.
const runs = (path: string) => config.matcher.some((source) => new RegExp(`^${source}$`).test(path));

describe("proxy matcher", () => {
  it("skips the static public pages", () => {
    for (const path of ["/", "/privacy", "/terms"]) expect(runs(path), path).toBe(false);
  });

  it("skips the Telegram webhook, which has no session, and only that API path", () => {
    expect(runs("/api/telegram/webhook")).toBe(false);
    for (const path of ["/api/telegram/webhook/x", "/api/telegram", "/api/connectors/telegram/send"]) expect(runs(path), path).toBe(true);
  });

  it("still runs on workspace, auth and API paths", () => {
    for (const path of ["/chat", "/today", "/connectors", "/login", "/signup", "/reset-password", "/api/chat", "/privacy/x", "/terms-old"]) {
      expect(runs(path), path).toBe(true);
    }
  });
});
