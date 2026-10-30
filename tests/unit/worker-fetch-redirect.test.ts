import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Cloudflare Workers throw a TypeError for fetch(..., { redirect: "error" }).
// Only "follow" and "manual" work, so every outside call uses "manual" and
// treats a 3xx answer as a failed request.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("fetch redirect mode", () => {
  it("never uses redirect: \"error\", which the Workers runtime refuses", () => {
    const offenders = sourceFiles("src").filter((file) => /redirect:\s*["']error["']/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
