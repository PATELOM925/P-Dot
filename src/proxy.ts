import type { NextRequest } from "next/server";
import { updateSession } from "@/server/auth/proxy-session";

// Next.js 16 "proxy" (formerly middleware): refreshes the auth session cookie
// and redirects signed-out visitors away from workspace pages. Authorization is
// still enforced again in every page and API route.
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

// Static files, including the installable app's service worker, manifest and
// offline page, need no session. The static public pages (/, /privacy, /terms)
// read no session either, so the proxy skips them: on the free Workers plan a
// request has 10 ms of CPU. /login and /signup keep the proxy, which sends a
// signed-in user on to /chat. The Telegram webhook has no session and checks
// its own secret header (decision 0020).
export const config = {
  matcher: [
    "/((?!$|privacy$|terms$|api/telegram/webhook$|_next/static|_next/image|favicon.ico|sw\\.js$|manifest\\.webmanifest$|offline\\.html$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
