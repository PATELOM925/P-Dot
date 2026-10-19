import { describe, expect, it } from "vitest";
import { findBakedSecrets } from "../../scripts/check-worker-env.mjs";

describe("findBakedSecrets", () => {
  it("flags secret-like names that have a value", () => {
    const found = findBakedSecrets({
      production: {
        NEBIUS_API_KEY: "abc",
        TAVILY_API_KEY: "def",
        SUPABASE_DB_PASSWORD: "x",
        GITHUB_TOKEN: "y",
        DATABASE_URL: "z",
      },
      development: { NEBIUS_API_KEY: "abc" },
    });
    expect(found).toEqual([
      "production.NEBIUS_API_KEY",
      "production.TAVILY_API_KEY",
      "production.SUPABASE_DB_PASSWORD",
      "production.GITHUB_TOKEN",
      "production.DATABASE_URL",
      "development.NEBIUS_API_KEY",
    ]);
  });

  it("allows empty secrets, public values and plain settings", () => {
    const found = findBakedSecrets({
      production: {
        NEBIUS_API_KEY: "",
        TAVILY_API_KEY: "   ",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public",
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SITE_URL: "https://pdot.iampatelom.com",
        CHAT_WINDOW_SECONDS: "3600",
        NEBIUS_MAX_OUTPUT_TOKENS: "1024",
        NEBIUS_BASE_URL: "https://api.tokenfactory.nebius.com/v1",
        KEYBOARD_LAYOUT: "us",
      },
      test: {},
    });
    expect(found).toEqual([]);
  });

  it("never returns values", () => {
    const found = findBakedSecrets({ production: { NEBIUS_API_KEY: "super-secret-value" } });
    expect(found.join(" ")).not.toContain("super-secret-value");
  });
});
