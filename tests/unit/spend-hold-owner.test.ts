import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// One owner for "worst-case hold for a Nebius call". A second copy of the hold
// math reduced a required hold before (PR #6, 0dce68a), so other files must call the owner.

const ROOT = join(__dirname, "..", "..");
const OWNER = "src/server/assistant/spend.ts";
const PRICING = "src/server/providers/nebius/pricing.ts";
const FIX =
  `Only ${OWNER} may compute a Nebius hold. Use nebiusHoldMicroUsd (chat) or ` +
  "nebiusEmbeddingHoldMicroUsd (embeddings) for the hold, and nebiusSettleMicroUsd for the settle. " +
  "They refuse a hold above the ceiling with NebiusHoldTooLargeError and never reduce it.";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("Nebius hold owner", () => {
  it("is the only file that uses the hold ceiling or prices a hold", () => {
    const files = sourceFiles(join(ROOT, "src")).map((path) => relative(ROOT, path));
    expect(files).toContain(OWNER);

    const offenders: string[] = [];
    for (const file of files) {
      if (file === OWNER) continue;
      const code = withoutComments(readFileSync(join(ROOT, file), "utf8"));
      if (/\bMAX_NEBIUS_HOLD_MICRO_USD\b/.test(code)) offenders.push(`${file}: MAX_NEBIUS_HOLD_MICRO_USD`);
      if (file !== PRICING && /\bcostMicroUsd\b/.test(code)) offenders.push(`${file}: costMicroUsd`);
    }
    expect(offenders, `${offenders.join("\n")}\n${FIX}`).toEqual([]);
  });
});
