// Stops a deploy when a local .env file would put a secret inside the Worker bundle.
// The OpenNext build copies every value from .env, .env.local and .env.production
// into .open-next/cloudflare/next-env.mjs, which is uploaded with the Worker.
// Secrets must be Worker secrets (`npx wrangler secret put NAME`) instead.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// Matched against whole name parts, so NEBIUS_MAX_OUTPUT_TOKENS is not a secret but GITHUB_TOKEN is.
const SECRET_PARTS = new Set(["KEY", "SECRET", "TOKEN", "PASSWORD", "PASS", "PWD", "CREDENTIAL", "CREDENTIALS", "DSN"]);
const SECRET_NAME = /(DATABASE_URL|CONNECTION_STRING|_DB_URL$)/i;
const PUBLIC_NAME = /^NEXT_PUBLIC_/;

function isSecretName(name) {
  return SECRET_NAME.test(name) || name.toUpperCase().split("_").some((part) => SECRET_PARTS.has(part));
}

/** Returns "mode.NAME" for each secret-like variable that has a value. Names only, never values. */
export function findBakedSecrets(envByMode) {
  const found = [];
  for (const [mode, vars] of Object.entries(envByMode)) {
    if (!vars || typeof vars !== "object") continue;
    for (const [name, value] of Object.entries(vars)) {
      if (PUBLIC_NAME.test(name) || !isSecretName(name)) continue;
      if (typeof value === "string" && value.trim() !== "") found.push(`${mode}.${name}`);
    }
  }
  return found;
}

async function main() {
  const file = resolve(".open-next/cloudflare/next-env.mjs");
  if (!existsSync(file)) {
    console.error(`check-worker-env: ${file} not found. Run the OpenNext build first.`);
    process.exit(1);
  }
  const envByMode = await import(pathToFileURL(file).href);
  const found = findBakedSecrets(envByMode);
  if (found.length > 0) {
    console.error("check-worker-env: these secret values from a local .env file would be uploaded in the Worker bundle:");
    for (const name of found) console.error(`  - ${name}`);
    console.error("Production deploys run in Workers Builds, where no .env file exists. For a manual deploy, move these");
    console.error("values out of every .env file first. Store production secrets with `npx wrangler secret put NAME`.");
    process.exit(1);
  }
  console.log("check-worker-env: no secret values in the Worker bundle env file.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
