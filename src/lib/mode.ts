import type { Mode } from "@/types/api";

/** Cookie remembering which side (Personal or Work) the user is viewing. */
export const MODE_COOKIE = "pdot_mode";

export const DEFAULT_MODE: Mode = "personal";

export const MODE_LABELS: Record<Mode, string> = {
  personal: "Personal",
  work: "Work",
};

export function parseMode(value: unknown): Mode {
  return value === "work" || value === "personal" ? value : DEFAULT_MODE;
}
