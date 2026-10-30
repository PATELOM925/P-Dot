import Link from "next/link";
import { BrandLink } from "@/components/layout/BrandLink";
import { TryWithoutAccount } from "@/features/auth/TryWithoutAccount";
import { DynamicAgentCard } from "@/features/landing/DynamicAgentCard";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { Mascot } from "@/components/ui/Mascot";

const CONNECTORS = [
  { name: "Gmail", chip: "chip-gmail" },
  { name: "Calendar", chip: "chip-calendar" },
  { name: "Notion", chip: "chip-neutral" },
  { name: "Linear", chip: "chip-neutral" },
  { name: "Todoist", chip: "chip-neutral" },
];

// Built once at build time, with no session read: the free Workers plan allows 10 ms of CPU
// for each request. A signed-in visitor who picks "Try P-Dot now" keeps
// the current session (startTrial), and "I have an account" goes on from /login to /chat.
export const dynamic = "force-static";

export default function LandingPage() {
  return (
    <div className="landing">
      <header className="landing-header">
        <BrandLink />
        <nav className="actions" aria-label="Account">
          <Link className="button" href="/login">
            Sign in
          </Link>
          <Link className="button button-primary" href="/signup">
            Create an account
          </Link>
        </nav>
      </header>

      <main className="landing-body">
        <section className="landing-copy">
          <div className="hero-intro">
            <Mascot size={64} float />
            <p className="pill">Your personal assistant bot</p>
          </div>
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
            <TryWithoutAccount />
            <Link className="button button-large" href="/signup">
              Create an account
            </Link>
            <Link className="button button-large" href="/login">
              I have an account
            </Link>
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
