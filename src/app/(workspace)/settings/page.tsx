import type { Metadata } from "next";
import Link from "next/link";
import { signOutAction } from "@/features/auth/actions";
import { requireAuth } from "@/server/auth/session";

export const metadata: Metadata = { title: "Settings · P-Dot" };

export default async function SettingsPage() {
  const auth = await requireAuth("/settings");

  return (
    <main className="page stack">
      <h1>Settings</h1>

      <section className="card stack" aria-labelledby="account-heading">
        <h2 id="account-heading">Account</h2>
        <p>
          Signed in as <strong>{auth.email ?? "your account"}</strong>
        </p>
        <div className="actions">
          <Link className="button" href="/reset-password">
            Change password
          </Link>
          <form action={signOutAction}>
            <button type="submit" className="button">
              Sign out
            </button>
          </form>
        </div>
      </section>

      <section className="card stack" aria-labelledby="data-heading">
        <h2 id="data-heading">How your data is used</h2>
        <ul className="plain-list">
          <li>
            <strong>Inference (Nebius Token Factory):</strong> each message you send, together with recent
            messages from the same conversation, is sent to Nebius to generate the reply.
          </li>
          <li>
            <strong>Web search (Tavily):</strong> only when you turn on web search for a message, the text of
            that message is sent to Tavily as the search query. Retrieved excerpts are then sent to Nebius as
            context.
          </li>
          <li>
            <strong>Voice dictation:</strong> the microphone button uses your browser&apos;s built-in speech
            recognition to turn speech into English text. Your browser vendor&apos;s speech service may process the
            audio; P-Dot&apos;s servers only receive the text you choose to send.
          </li>
          <li>
            <strong>Personal and Work modes:</strong> each conversation and to-do item belongs to one mode, and the
            assistant stays within that mode&apos;s topics.
          </li>
          <li>
            <strong>Storage (Supabase):</strong> your account and conversations are stored in a Supabase
            database, visible only to your account.
          </li>
          <li>
            <strong>Logs:</strong> the server logs request metadata (timing, status, error type) but not your
            message text or search queries.
          </li>
        </ul>
      </section>

      <section className="card stack" aria-labelledby="retention-heading">
        <h2 id="retention-heading">Retention and deletion</h2>
        <p>
          Conversations are kept until you delete them. Deleting a conversation from the chat sidebar removes
          it and its messages from the active database immediately. Database backups may keep a copy until
          they expire according to the hosting plan&apos;s backup retention.
        </p>
        <p className="muted">
          Self-service account deletion is not available yet. The final retention policy is still being
          decided and will be published before public release.
        </p>
      </section>
    </main>
  );
}
