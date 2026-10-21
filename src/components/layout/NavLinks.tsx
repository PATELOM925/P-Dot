"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WaitingApprovalsBadge } from "@/features/actions/WaitingApprovalsBadge";

const LINKS = [
  { href: "/today", label: "Today" },
  { href: "/chat", label: "Chat" },
  { href: "/memory", label: "Memory" },
  { href: "/workflows", label: "Workflows" },
  { href: "/connectors", label: "Connectors" },
  { href: "/action-log", label: "Action log" },
  { href: "/settings", label: "Settings" },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Workspace" className="main-nav">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="nav-link"
          aria-current={pathname === link.href ? "page" : undefined}
        >
          {link.label}
          {/* Today holds the approval panel, so the waiting count goes there. */}
          {link.href === "/today" && <WaitingApprovalsBadge />}
        </Link>
      ))}
    </nav>
  );
}
