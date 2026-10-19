// Rules for scripts/check-worker-env.mjs. Kept apart from the command so tests can import them.
//
// Allow list, not a block list: a name-based block list always misses some secret
// (PGPASSWORD, POSTGRES_URL, ...). Only these names may have a value in the Worker
// bundle env file. None of them is a secret. To add a name, it must not be a secret.
export const ALLOWED_NAMES = new Set([
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SITE_URL",
  "NEBIUS_BASE_URL",
  "NEBIUS_MODEL",
  "NEBIUS_MAX_OUTPUT_TOKENS",
  "CHAT_REQUESTS_PER_WINDOW",
  "CHAT_WINDOW_SECONDS",
]);

/** Returns "mode.NAME" for each variable that has a value but is not allowed. Names only, never values. */
export function findBakedSecrets(envByMode) {
  const found = [];
  for (const [mode, vars] of Object.entries(envByMode)) {
    if (!vars || typeof vars !== "object") continue;
    for (const [name, value] of Object.entries(vars)) {
      if (ALLOWED_NAMES.has(name)) continue;
      if (typeof value === "string" && value.trim() !== "") found.push(`${mode}.${name}`);
    }
  }
  return found;
}
