import type { Metadata } from "next";
import Link from "next/link";
import { ApprovalModeOptions } from "@/features/actions/ApprovalModePicker";
import { KIND_LABELS } from "@/features/actions/format";
import { signOutAction } from "@/features/auth/actions";
import { FeedbackCard } from "@/features/feedback/FeedbackCard";
import { AppSettings } from "@/features/pwa/AppSettings";
import { ACTION_EFFECTS, ALWAYS_ASK_REASONS, MAX_AUTO_ACTIONS_PER_REPLY } from "@/lib/approval-policy";
import { requireAuth } from "@/server/auth/session";
import type { ActionKind } from "@/types/api";

// Read from the shared policy, so this page always matches what Auto mode does.
const RUNS_ON_ITS_OWN = (Object.keys(ACTION_EFFECTS) as ActionKind[])
  .filter((kind) => ACTION_EFFECTS[kind] === "create_own")
  .map((kind) => KIND_LABELS[kind]);

export const metadata: Metadata = { title: "Settings · P-Dot" };

export default async function SettingsPage() {
  const auth = await requireAuth("/settings");

  return (
    <main className="page stack">
      <h1>Settings</h1>

      <section className="card stack" aria-labelledby="account-heading">
        <h2 id="account-heading">Account</h2>
        {auth.isAnonymous ? (
          <>
            <p>
              You are trying P-Dot without an account. A trial has no email and no password. When you end the trial,
              you cannot open its chats again.
            </p>
            <div className="actions">
              <Link className="button button-primary" href="/signup">
                Create an account
              </Link>
              <form action={signOutAction}>
                <button type="submit" className="button">
                  End trial
                </button>
              </form>
            </div>
          </>
        ) : (
          <>
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
          </>
        )}
      </section>

      <section id="approvals" className="card stack" aria-labelledby="approvals-heading">
        <h2 id="approvals-heading">Approvals</h2>
        <ApprovalModeOptions />
        <details className="more-details stack">
          <summary>What Auto does</summary>
          <p className="small">
            In Auto, for replies to messages you send while it is on, P-Dot does these on its own and shows them under the
            reply with Undo: {RUNS_ON_ITS_OWN.join(", ").toLowerCase()}. At most {MAX_AUTO_ACTIONS_PER_REPLY} for one
            reply; the rest ask. You can also switch with the button next to the message box.
          </p>
          <h3>Always asks, even in Auto</h3>
          <ul className="plain-list">
            {Object.values(ALWAYS_ASK_REASONS).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className="hint">
            Your choice is saved on this device. Each action shows in <Link href="/activity">Activity</Link>.
          </p>
        </details>
      </section>

      <AppSettings />

      <section className="card stack" aria-labelledby="devices-heading">
        <h2 id="devices-heading">Devices</h2>
        <p>
          <Link href="/devices">Open devices</Link>
        </p>
      </section>

      <FeedbackCard className="card stack" />

      <details className="card stack card-details" aria-labelledby="data-heading">
        <summary>
          <h2 id="data-heading">How your data is used</h2>
        </summary>
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
            <strong>Memory:</strong> when you save or edit a memory, its text is sent to Nebius once to make it
            searchable (an embedding). The text of kept memories that match your message is sent with it. You can see, change and delete all of them
            on the <Link href="/memory">Memory</Link> page.
          </li>
          <li>
            <strong>Documents:</strong> when you add a text or Markdown file, its text is sent to Nebius once, in
            parts, to make it searchable. When P-Dot searches your documents for a reply, the matching parts are sent with it. They are listed, and can be deleted,
            on the <Link href="/memory#documents">Memory</Link> page.
          </li>
          <li>
            <strong>Approvals:</strong> when P-Dot proposes adding a task, a reminder or a memory, nothing happens
            until you approve it. You can edit the proposal first or cancel it.
          </li>
          <li>
            <strong>What was sent:</strong> for each reply, P-Dot records which model answered and how much context it
            received (counts and IDs, not a copy of the text). Open it with &ldquo;What was sent&rdquo; under a reply.
          </li>
          <li>
            <strong>Activity:</strong> approvals, cancellations, completed actions and changes to memories,
            documents and reminders are recorded without their text, and cannot be edited or deleted. See{" "}
            <Link href="/activity">Activity</Link>.
          </li>
          <li>
            <strong>Feedback:</strong> what you send in &ldquo;What should P-Dot connect to next?&rdquo; is stored with
            your account, so the team can read it.
          </li>
          <li>
            <strong>Storage (Supabase):</strong> your account, conversations, tasks, memories, documents, reminders and
            the Activity record are stored in a Supabase database, visible only to your account.
          </li>
          <li>
            <strong>Logs:</strong> the server logs request metadata (timing, status, error type) but not your
            message text or search queries.
          </li>
        </ul>
      </details>

      <details className="card stack card-details" aria-labelledby="retention-heading">
        <summary>
          <h2 id="retention-heading">Retention and deletion</h2>
        </summary>
        <p>
          Conversations are kept until you delete them. Deleting a conversation from the chat sidebar removes
          it and its messages from the active database immediately. Database backups may keep a copy until
          they expire according to the hosting plan&apos;s backup retention.
        </p>
        <p>
          Deleting a memory or a document removes its text and search vector at once. Action proposals and the Activity
          record are kept as an audit record and cannot be deleted from the app; they hold kinds, counts and IDs, and a
          proposal also keeps the details you were asked to approve.
        </p>
        <p className="muted">
          Self-service account deletion is not available yet. The final retention policy is still being
          decided and will be published before public release.
        </p>
      </details>
    </main>
  );
}
