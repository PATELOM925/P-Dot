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

// Illustrative example only (not real data): how P-Dot is designed to work on a task.
const EXAMPLE_STEPS = [
  { title: "Understood the goal", detail: "Prepare for Friday, book a haircut for Saturday morning.", state: "done" },
  { title: "Checked your calendar", tool: "Calendar", detail: "Two meetings Friday. Saturday 11:00 is free.", state: "done" },
  { title: "Read your inbox and drafted a reply", tool: "Gmail", detail: "One email needs an answer. Draft saved, not sent.", state: "done" },
  { title: "Ready to call the salon", state: "approval" },
  { title: "Then send your brief", tool: "Telegram", detail: "Summary and to-do list to your own chat.", state: "next" },
] as const;

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

        <section className="agent-card" aria-label="Example of an agent run">
          <div className="agent-card-head">
            <div>
              <p className="small muted agent-label">Task</p>
              <p className="agent-task">Get me ready for Friday and book a haircut</p>
            </div>
            <span className="chip chip-warning">1 step needs you</span>
          </div>
          <ol className="agent-steps">
            {EXAMPLE_STEPS.map((step, index) => (
              <li key={step.title} className={`agent-step agent-step-${step.state}`}>
                <span className="agent-bullet" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="agent-step-body">
                  <p className="agent-step-title">{step.title}</p>
                  {"tool" in step && (
                    <p className="agent-step-detail">
                      <span className={`chip chip-${step.tool.toLowerCase()}`}>{step.tool}</span> {step.detail}
                    </p>
                  )}
                  {step.state === "done" && !("tool" in step) && <p className="agent-step-detail">{step.detail}</p>}
                  {step.state === "approval" && (
                    <div className="agent-approval">
                      <p className="small">Book Saturday 11:00 by phone. P-Dot only calls after you approve.</p>
                      <div className="actions">
                        <span className="button button-primary button-small" aria-hidden="true">
                          Approve
                        </span>
                        <span className="button button-small" aria-hidden="true">
                          Skip
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <p className="small muted agent-foot">
            Illustrative example of the planned design; automations and connectors are not available yet. AI can make
            mistakes, so P-Dot will show each step and check with you first.
          </p>
        </section>
      </main>
    </div>
  );
}
