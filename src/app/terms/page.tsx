import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/layout/LegalPage";

export const metadata: Metadata = { title: "Terms · P-Dot" };

// Built once at build time, so a request does no rendering work.
export const dynamic = "force-static";

export default function TermsPage() {
  return (
    <LegalPage title="Terms" updated="30 October 2026">
      <section>
        <h2>What P-Dot is</h2>
        <p>
          P-Dot is a hackathon project. It comes as is, with no warranty. It can stop, change or lose data at any time.
          Do not use it for work where a mistake can cause harm.
        </p>
      </section>
      <section>
        <h2>Answers can be wrong</h2>
        <p>
          AI models write the replies, and they can make mistakes. Check important facts. P-Dot does not give medical,
          legal or financial advice.
        </p>
      </section>
      <section>
        <h2>Your approval</h2>
        <p>
          P-Dot asks before it adds a task, a reminder or a memory, and before it changes a connected account. You are
          responsible for what you approve.
        </p>
      </section>
      <section>
        <h2>Fair use</h2>
        <p>
          Do not use P-Dot to break the law, to attack the service or to get around its limits. Each account and the
          whole site have usage limits, and P-Dot can refuse a request when a limit is reached.
        </p>
      </section>
      <section>
        <h2>Your data</h2>
        <p>
          You keep your content. See <Link href="/privacy">Privacy</Link> for what P-Dot stores and sends.
        </p>
      </section>
    </LegalPage>
  );
}
