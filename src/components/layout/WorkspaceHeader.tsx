import Link from "next/link";
import { signOutAction } from "@/features/auth/actions";
import type { Mode } from "@/types/api";
import { ModeToggle } from "./ModeToggle";
import { NavLinks } from "./NavLinks";

export function WorkspaceHeader({ email, mode }: { email: string | null; mode: Mode }) {
  return (
    <header className="workspace-header">
      <Link href="/chat" className="brand">
        P-Dot
      </Link>
      <NavLinks />
      <div className="header-account">
        <ModeToggle mode={mode} />
        {email && <span className="muted small header-email">{email}</span>}
        <form action={signOutAction}>
          <button type="submit" className="button button-small">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
