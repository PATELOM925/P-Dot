import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

  it("keeps the production workers.dev address off", () => {
    expect(config.workers_dev).toBe(false);
  });
});
