import Link from "next/link";
import { ConfigError } from "@/lib/supabase-config";
import { getAuthContext } from "@/server/auth/session";
import { TryWithoutAccount } from "@/features/auth/TryWithoutAccount";
import { DynamicAgentCard } from "@/features/landing/DynamicAgentCard";
import { SiteFooter } from "@/components/layout/SiteFooter";

const CONNECTORS = [
  { name: "Gmail", chip: "chip-gmail" },
  { name: "Calendar", chip: "chip-calendar" },
  { name: "Notion", chip: "chip-neutral" },
  { name: "Linear", chip: "chip-neutral" },
  { name: "Todoist", chip: "chip-neutral" },
];

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
            A personal assistant on open NVIDIA Nemotron models. It asks before every action and logs each one. You can
            see and edit everything it remembers.
          </p>
          <div className="actions">
            {signedIn ? (
              <Link className="button button-primary button-large" href="/chat">
                Open your workspace
              </Link>
            ) : (
              <>
                <TryWithoutAccount />
                <Link className="button button-large" href="/signup">
                  Create an account
                </Link>
                <Link className="button button-large" href="/login">
                  I have an account
                </Link>
              </>
            )}
          </div>
          <div className="connect-row">
            <span className="connect-label">Connect your tools</span>
            {CONNECTORS.map(({ name, chip }) => (
              <span key={name} className={`chip ${chip}`}>
                {name}
              </span>
            ))}
            <Link className="button button-primary button-small" href="/connectors">
              Connect
            </Link>
          </div>
          <p className="muted small landing-note">
            <strong>Powered by NVIDIA Nemotron through Nebius.</strong> P-Dot sends each message to a Nemotron model
            that fits it: a fast model for everyday questions, a stronger model when you ask it to think harder. Under
            each reply, &ldquo;What was sent&rdquo; shows the model, the memories, the documents and the web sources
            that the reply used.
          </p>
        </section>

        <DynamicAgentCard />
      </main>
      <SiteFooter />
    </div>
  );
}
