"use server";

import { cookies } from "next/headers";
import { MODE_COOKIE, parseMode } from "@/lib/mode";

/**
 * Remembers the selected mode. It only changes what the UI lists and which
 * scope new conversations use; it is not an authorization control.
 * Calling a server action that sets a cookie re-renders the current page.
 */
export async function setModeAction(value: string): Promise<void> {
  const store = await cookies();
  store.set(MODE_COOKIE, parseMode(value), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}
