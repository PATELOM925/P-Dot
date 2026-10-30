import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { hasAccount } from "@/lib/auth-identity";
import { requireAuth } from "@/server/auth/session";
import { getTelegramConfig } from "@/server/config";
import { MAX_PROOF_CHARS, openLinkProof } from "@/server/telegram/seal";

export const metadata: Metadata = { title: "Link Telegram · P-Dot" };

/** The proof as of the time of the request. */
function readProof(key: Uint8Array, text: string) {
  return openLinkProof(key, text, Date.now());
}

interface ConfirmPageProps {
  searchParams: Promise<{ t?: string | string[] }>;
}

/**
 * The page that the bot's "Finish linking in P-Dot" button opens (decision
 * 0020). It shows which Telegram chat asks to link, and links it only after a
 * press on the button. A GET never changes anything.
 */
export default async function TelegramConfirmPage({ searchParams }: ConfirmPageProps) {
  const { t } = await searchParams;
  const proofText = typeof t === "string" && t.length <= MAX_PROOF_CHARS ? t : null;
  const auth = await requireAuth(proofText ? `/connectors/telegram/confirm?t=${encodeURIComponent(proofText)}` : "/connectors");
  const config = getTelegramConfig();
  const proof = config.status === "ready" && proofText ? await readProof(config.config.sealKey, proofText) : null;

  let body: React.ReactNode;
  if (config.status !== "ready") {
    body = <p>Telegram is not set up on this site yet.</p>;
  } else if (!hasAccount(auth)) {
    body = (
      <p>
        Create an account to link Telegram. A demo session cannot link an app. <Link href="/signup">Create an account</Link>
      </p>
    );
  } else if (proof === "expired") {
    body = <p>This link ended. On the Connectors page, select Link Telegram to start again.</p>;
  } else if (!proof) {
    body = <p className="alert alert-error">This link is not valid. On the Connectors page, select Link Telegram to start again.</p>;
  } else {
    body = (
      <>
        <p>
          Link the Telegram chat of <strong>{proof.name || "this Telegram user"}</strong> to your P-Dot account?
        </p>
        <p className="muted">
          P-Dot sends a message to this chat only when you press Send on its card. Link only a chat that is yours.
        </p>
        <form method="post" action="/api/connectors/telegram/confirm" className="actions">
          <input type="hidden" name="t" value={proofText ?? ""} />
          <button type="submit" className="button button-primary">
            Link this chat
          </button>
          <Link href="/connectors" className="button">
            Cancel
          </Link>
        </form>
      </>
    );
  }

  return (
    <main className="page stack">
      <PageHeader title="Link Telegram" />
      <section className="panel stack">{body}</section>
      <p>
        <Link href="/connectors#telegram">Back to Connectors</Link>
      </p>
    </main>
  );
}
