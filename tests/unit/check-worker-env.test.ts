import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBakedSecrets, isSecretName } from "../../scripts/worker-env-rules.mjs";

const SCRIPT = resolve("scripts/check-worker-env.mjs");
const FAKE = "fake-secret-value-123";

describe("findBakedSecrets", () => {
  it("flags secret-like names that have a value", () => {
    const found = findBakedSecrets({
      production: {
        NEBIUS_API_KEY: "abc",
        TAVILY_API_KEY: "def",
        SUPABASE_DB_PASSWORD: "x",
        GITHUB_TOKEN: "y",
        DATABASE_URL: "z",
        SUPABASE_SERVICE_ROLE: "s",
        NEXT_PUBLIC_NEBIUS_API_KEY: "p",
      },
      development: { NEBIUS_API_KEY: "abc" },
    });
    expect(found).toEqual([
      "production.NEBIUS_API_KEY",
      "production.TAVILY_API_KEY",
      "production.SUPABASE_DB_PASSWORD",
      "production.GITHUB_TOKEN",
      "production.DATABASE_URL",
      "production.SUPABASE_SERVICE_ROLE",
      "production.NEXT_PUBLIC_NEBIUS_API_KEY",
      "development.NEBIUS_API_KEY",
    ]);
  });

  it("allows empty secrets, the two public Supabase values and plain settings", () => {
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

  it("treats only the two known public names as public", () => {
    expect(isSecretName("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")).toBe(false);
    expect(isSecretName("NEXT_PUBLIC_OTHER_KEY")).toBe(true);
  });
});

describe("check-worker-env command", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function project(envFile?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "pdot-env-"));
    dirs.push(dir);
    if (envFile !== undefined) {
      mkdirSync(join(dir, ".open-next/cloudflare"), { recursive: true });
      writeFileSync(join(dir, ".open-next/cloudflare/next-env.mjs"), envFile);
    }
    return dir;
  }
  const run = (cwd: string, script = SCRIPT) => spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
  const withSecret = `export const production = {"NEBIUS_API_KEY":"${FAKE}"};\nexport const development = {};\nexport const test = {};\n`;

  it("fails and prints the name, not the value", () => {
    const result = run(project(withSecret));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("production.NEBIUS_API_KEY");
    expect(result.stdout + result.stderr).not.toContain(FAKE);
  });

  it("fails when started through a symbolic link", () => {
    const dir = project(withSecret);
    const link = join(dir, "linked-check.mjs");
    symlinkSync(SCRIPT, link);
    expect(run(dir, link).status).toBe(1);
  });

  it("fails when the build output is missing", () => {
    const result = run(project());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Run the OpenNext build first");
  });

  it("passes when no secret has a value", () => {
    const clean = `export const production = {"NEBIUS_API_KEY":"","SITE_URL":"https://pdot.iampatelom.com"};\nexport const development = {};\nexport const test = {};\n`;
    expect(run(project(clean)).status).toBe(0);
  });
});
