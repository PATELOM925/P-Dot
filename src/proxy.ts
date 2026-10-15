import type { NextRequest } from "next/server";
import { updateSession } from "@/server/auth/proxy-session";

// Next.js 16 "proxy" (formerly middleware): refreshes the auth session cookie
// and redirects signed-out visitors away from workspace pages. Authorization is
// still enforced again in every page and API route.
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
