import Link from "next/link";
import { signOutAction } from "@/features/auth/actions";

export function WorkspaceHeader({ email }: { email: string | null }) {
  return (
    <header className="workspace-header">
      <Link href="/chat" className="brand">
        P-Dot
      </Link>
      <nav aria-label="Workspace">
        <Link href="/chat">Chat</Link>
        <Link href="/settings">Settings</Link>
      </nav>
      <div className="header-account">
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
