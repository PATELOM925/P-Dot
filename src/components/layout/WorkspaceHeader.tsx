import Link from "next/link";
import { signOutAction } from "@/features/auth/actions";
import { InstallButton } from "@/features/pwa/InstallButton";
import type { Mode } from "@/types/api";
import { ModeToggle } from "./ModeToggle";
import { NavLinks } from "./NavLinks";
import { ThemeToggle } from "./ThemeToggle";

export function WorkspaceHeader({ email, trial, mode }: { email: string | null; trial: boolean; mode: Mode }) {
  return (
    <header className="workspace-header">
      <Link href="/chat" className="brand">
        P-Dot
      </Link>
      <NavLinks />
      <div className="header-account">
        <InstallButton />
        <ThemeToggle />
        <ModeToggle mode={mode} />
        {trial ? (
          <span className="status-pill header-trial">Trial</span>
        ) : (
          email && <span className="muted small header-email">{email}</span>
        )}
        <form action={signOutAction} className="header-signout">
          <button type="submit" className="button button-small">
            {trial ? "End trial" : "Sign out"}
          </button>
        </form>
      </div>
    </header>
  );
}
