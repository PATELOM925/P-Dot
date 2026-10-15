import Link from "next/link";
import { ConfigError } from "@/lib/supabase-config";
import { getAuthContext } from "@/server/auth/session";

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
    <main className="landing">
      <p className="brand">P-Dot</p>
      <h1>Your personal assistant for everyday questions, research, writing, and planning.</h1>
      <p className="lead">
        Ask anything, turn on web search when you need current sources, and come back to your private
        conversation history any time.
      </p>
      <div className="actions">
        {signedIn ? (
          <Link className="button button-primary" href="/chat">
            Open your workspace
          </Link>
        ) : (
          <>
            <Link className="button button-primary" href="/signup">
              Create an account
            </Link>
            <Link className="button" href="/login">
              Sign in
            </Link>
          </>
        )}
      </div>
      <p className="muted small">
        P-Dot answers inside the conversation only. It does not send messages, change your accounts, or take
        actions on your behalf.
      </p>
    </main>
  );
}
