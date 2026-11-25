"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { startActiveTimeSession } from "./active-time-session";

export function ActiveTimeTracker() {
  const pathname = usePathname();
  useEffect(() => {
    const screen = pathname.startsWith("/today") ? "today"
      : pathname.startsWith("/connectors") ? "connectors"
        : pathname.startsWith("/memory") ? "memory"
          : pathname.startsWith("/activity") ? "activity"
            : pathname.startsWith("/settings") ? "settings" : "chat";
    return startActiveTimeSession(() => screen, {
      window,
      document,
      locks: typeof navigator === "undefined" ? undefined : navigator.locks,
      fetch,
    });
  }, [pathname]);
  return null;
}
