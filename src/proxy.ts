import type { NextRequest } from "next/server";
import { updateSession } from "@/server/auth/proxy-session";

// Next.js 16 "proxy" (formerly middleware): refreshes the auth session cookie
// and redirects signed-out visitors away from workspace pages. Authorization is
// still enforced again in every page and API route.
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

// Static files, including the installable app's service worker, manifest and
// offline page, need no session.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sw\\.js$|manifest\\.webmanifest$|offline\\.html$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
