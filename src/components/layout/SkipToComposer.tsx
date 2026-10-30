"use client";

import { usePathname } from "next/navigation";

/** The first Tab stop on the chat page. It jumps past the nav and the conversation list to the message box. */
export function SkipToComposer() {
  const pathname = usePathname();
  if (pathname !== "/chat") return null;
  return (
    <a
      href="#composer-input"
      className="skip-link"
      onClick={(event) => {
        const input = document.getElementById("composer-input");
        if (!input) return;
        event.preventDefault();
        input.focus();
      }}
    >
      Skip to message box
    </a>
  );
}
