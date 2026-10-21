import Link from "next/link";
import { ConfigError } from "@/lib/supabase-config";
import { getAuthContext } from "@/server/auth/session";
import { DynamicAgentCard } from "@/features/landing/DynamicAgentCard";

async function isSignedIn(): Promise<boolean> {
  try {
    return (await getAuthContext()) !== null;
  } catch (error) {
    // Auth not configured yet: show the signed-out page. Rethrow anything else
    // (including Next.js's internal dynamic-rendering signal).
    if (error instanceof ConfigError) return false;
    throw error;
  }
}

export default async function LandingPage() {
  const signedIn = await isSignedIn();

  return (
    <div className="landing">
      <header className="landing-header">
        <Link href="/" className="brand">
          P-Dot
        </Link>
        <nav className="actions" aria-label="Account">
          {signedIn ? (
            <Link className="button button-primary" href="/chat">
              Open your workspace
            </Link>
          ) : (
            <>
              <Link className="button" href="/login">
                Sign in
              </Link>
              <Link className="button button-primary" href="/signup">
                Create an account
              </Link>
            </>
          )}
        </nav>
      </header>

      <main className="landing-body">
        <section className="landing-copy">
          <p className="pill">Your personal assistant bot</p>
          <h1>
            Don&apos;t just chat.
            <br />
            <span className="gradient-text">Get it done.</span>
          </h1>
          <p className="lead">
            A private agent on open Nemotron that never trains on your data. You can see and edit everything it
            remembers. It acts on your own laptop and phone, and every action is approved and logged.
          </p>
          <div className="actions">
            {signedIn ? (
              <Link className="button button-primary button-large" href="/chat">
                Open your workspace
              </Link>
            ) : (
              <>
                <Link className="button button-primary button-large" href="/signup">
                  Get started free
                </Link>
                <Link className="button button-large" href="/login">
                  I have an account
                </Link>
              </>
            )}
          </div>
          <div className="connect-row">
            <span className="connect-label">Connect your tools</span>
            {["Gmail", "Calendar", "GitHub", "Telegram"].map((name) => (
              <span key={name} className={`chip chip-${name.toLowerCase()}`}>
                {name}
              </span>
            ))}
            <Link className="button button-primary button-small" href="/connectors">
              Connect
            </Link>
          </div>
          <p className="muted small landing-note">
            <strong>Powered by NVIDIA Nemotron, deployed through Nebius</strong> on your own account, so you choose the
            model and hold the keys. Memory, approvals and the action log are in place; replies do not use memories yet,
            P-Dot does not propose actions in chat yet, and device actions are still being built.
          </p>
        </section>

        <DynamicAgentCard />
      </main>
    </div>
  );
}
