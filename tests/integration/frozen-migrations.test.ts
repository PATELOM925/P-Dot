import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrationFiles } from "../support/sql-gate";

/**
 * A merged migration has already run on the hosted database, so a change to
 * its file never reaches production. The baseline holds the SHA-256 of every
 * migration on main, in `shasum -a 256` format.
 */
const BASELINE = join(process.cwd(), "tests", "integration", "frozen-migrations.sha256");

function readBaseline(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of readFileSync(BASELINE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!match) throw new Error(`Bad line in ${BASELINE}: ${line}`);
    entries.set(match[2]!, match[1]!);
  }
  return entries;
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(join(MIGRATIONS_DIR, file))).digest("hex");

describe("frozen migrations", () => {
  const baseline = readBaseline();
  const files = migrationFiles();

  it.each([...baseline.keys()])("%s is unchanged", (file) => {
    expect(files, `${file} was deleted or renamed. Merged migrations stay as they are.`).toContain(file);
    expect(
      sha256(file),
      `${file} has already run on the hosted database. Do not edit it: add a new migration ` +
        "supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql with the change.",
    ).toBe(baseline.get(file));
  });

  it("names every migration <14-digit timestamp>_<name>.sql and puts new ones after the frozen ones", () => {
    const lastFrozen = [...baseline.keys()].sort().at(-1)!;
    for (const file of files) {
      expect(file).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
      if (!baseline.has(file)) {
        expect(file > lastFrozen, `${file} must sort after ${lastFrozen}, or it runs out of order.`).toBe(true);
      }
    }
  });
});
