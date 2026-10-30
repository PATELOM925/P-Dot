// Checks the "Unreleased" entries in CHANGELOG.md. Usage: node scripts/check-changelog.mjs [file]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findChangelogErrors } from "./changelog-rules.mjs";

const file = resolve(process.argv[2] ?? "CHANGELOG.md");
const errors = findChangelogErrors(readFileSync(file, "utf8"));
if (errors.length > 0) {
  console.error(`check-changelog: ${errors.length} problem(s) in ${file}:`);
  for (const error of errors) console.error(`  - ${error.message}`);
  console.error("Each entry needs a bold title, a Problem line, a Resolution line and a pull request or commit link (AGENTS.md).");
  process.exit(1);
}
console.log("check-changelog: every Unreleased entry has a title, Problem, Resolution and a link.");
