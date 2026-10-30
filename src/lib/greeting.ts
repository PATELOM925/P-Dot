/** "morning", "afternoon" or "evening" for an hour of the day (0 to 23). */
export function partOfDay(hour: number): "morning" | "afternoon" | "evening" {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}

/** A first name for a greeting from an email address, or null when it does not look like a name. */
export function nameFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const local = email.split("@")[0] ?? "";
  const word = local.split(/[._+-]/)[0] ?? "";
  const letters = word.replace(/[^\p{L}]/gu, "");
  if (letters.length < 2 || letters.length > 20) return null;
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
}
