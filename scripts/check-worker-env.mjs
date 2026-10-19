// Stops a deploy when a local .env file would put a secret inside the Worker bundle.
// The OpenNext build copies every value from .env, .env.local, .env.{mode} and
// .env.{mode}.local into .open-next/cloudflare/next-env.mjs, which is uploaded with
// the Worker. Secrets must be Worker secrets (`npx wrangler secret put NAME`) instead.
// Run it from the project root after `opennextjs-cloudflare build`.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findBakedSecrets } from "./worker-env-rules.mjs";

const file = resolve(".open-next/cloudflare/next-env.mjs");
if (!existsSync(file)) {
  console.error(`check-worker-env: ${file} not found. Run the OpenNext build first.`);
  process.exit(1);
}

const found = findBakedSecrets(await import(pathToFileURL(file).href));
if (found.length > 0) {
  console.error("check-worker-env: these values from a local .env file would be uploaded in the Worker bundle,");
  console.error("and they are not on the allow list in scripts/worker-env-rules.mjs:");
  for (const name of found) console.error(`  - ${name}`);
  console.error("Production deploys run in Workers Builds, where no .env file exists. For a manual deploy, move these");
  console.error("values out of every .env file first. Store production secrets with `npx wrangler secret put NAME`.");
  console.error("If a name is not a secret, add it to the allow list through a pull request.");
  process.exit(1);
}
console.log("check-worker-env: no secret values in the Worker bundle env file.");
