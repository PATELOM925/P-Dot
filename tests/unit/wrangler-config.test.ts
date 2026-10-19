import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAssistantConfig } from "@/server/config";
import { priceForModel } from "@/server/providers/nebius/pricing";
import { ALLOWED_NAMES } from "../../scripts/worker-env-rules.mjs";

// Removes // and /* */ comments outside strings, so wrangler.jsonc can be read with JSON.parse.
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      out += c;
    }
  }
  return out;
}

const config = JSON.parse(stripJsonComments(readFileSync("wrangler.jsonc", "utf8"))) as {
  workers_dev?: boolean;
  vars?: Record<string, string>;
  previews?: { vars?: Record<string, string> };
};

describe("wrangler.jsonc", () => {
  // Previews do not inherit top-level vars. A setting missing from previews.vars
  // makes Previews behave differently from production (for example no NEBIUS_MODEL).
  it("gives Previews the same variable names as production", () => {
    expect(Object.keys(config.previews?.vars ?? {}).sort()).toEqual(Object.keys(config.vars ?? {}).sort());
  });

  it("puts every runtime variable on the Worker env allow list", () => {
    for (const name of Object.keys(config.vars ?? {})) expect(ALLOWED_NAMES.has(name), name).toBe(true);
  });

  it("uses a model with a known price and spend caps that the config accepts", () => {
    const model = config.vars?.NEBIUS_MODEL ?? "";
    expect(priceForModel(model).known).toBe(true);
    for (const vars of [config.vars, config.previews?.vars]) {
      const parsed = getAssistantConfig({ ...vars, NEBIUS_API_KEY: "k", NODE_ENV: "test" });
      expect(parsed.spend).toEqual({
        nebius: { day: 1_000_000, period: 20_000_000, userDay: 250_000 },
        tavily: { day: 40, period: 800, userDay: 10 },
      });
    }
  });

  it("keeps the production workers.dev address off", () => {
    expect(config.workers_dev).toBe(false);
  });
});
