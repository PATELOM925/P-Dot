// Rules for scripts/check-worker-env.mjs. Kept apart from the command so tests can import them.

// The only values that may be in the Worker bundle env file. Both are public by design.
const ALLOWED_PUBLIC = new Set(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);

// Matched against whole name parts, so NEBIUS_MAX_OUTPUT_TOKENS is not a secret but GITHUB_TOKEN is.
const SECRET_PARTS = new Set([
  "KEY", "SECRET", "TOKEN", "PASSWORD", "PASS", "PWD", "CREDENTIAL", "CREDENTIALS", "DSN", "JWT", "PRIVATE",
]);
const SECRET_NAME = /(SERVICE_ROLE|DATABASE_URL|CONNECTION_STRING|_DB_URL$)/i;

export function isSecretName(name) {
  if (ALLOWED_PUBLIC.has(name)) return false;
  return SECRET_NAME.test(name) || name.toUpperCase().split("_").some((part) => SECRET_PARTS.has(part));
}

/** Returns "mode.NAME" for each secret-like variable that has a value. Names only, never values. */
export function findBakedSecrets(envByMode) {
  const found = [];
  for (const [mode, vars] of Object.entries(envByMode)) {
    if (!vars || typeof vars !== "object") continue;
    for (const [name, value] of Object.entries(vars)) {
      if (!isSecretName(name)) continue;
      if (typeof value === "string" && value.trim() !== "") found.push(`${mode}.${name}`);
    }
  }
  return found;
}
