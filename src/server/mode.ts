import "server-only";
import { cookies } from "next/headers";
import { MODE_COOKIE, parseMode } from "@/lib/mode";
import type { Mode } from "@/types/api";

/**
 * The mode the user last selected. It is only a view preference (what to list
 * and which scope new conversations use); it is never used for authorization.
 */
export async function getMode(): Promise<Mode> {
  const store = await cookies();
  return parseMode(store.get(MODE_COOKIE)?.value);
}
