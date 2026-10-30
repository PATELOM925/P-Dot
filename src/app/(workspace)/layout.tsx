import { BottomNav } from "@/components/layout/BottomNav";
import { TrialBanner } from "@/components/layout/TrialBanner";
import { WorkspaceHeader } from "@/components/layout/WorkspaceHeader";
import { requireAuth } from "@/server/auth/session";
import { getMode } from "@/server/mode";

// Server-side guard for every workspace page (the proxy redirect is only a convenience).
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth();
  const mode = await getMode();

  return (
    <div className="workspace">
      <WorkspaceHeader email={auth.email} trial={auth.isAnonymous === true} mode={mode} />
      {auth.isAnonymous && <TrialBanner />}
      {children}
      <BottomNav trial={auth.isAnonymous === true} />
    </div>
  );
}
