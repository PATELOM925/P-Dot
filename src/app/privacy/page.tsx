import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/LegalPage";

export const metadata: Metadata = { title: "Privacy · P-Dot" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" updated="30 October 2026">
      <section>
        <h2>What P-Dot stores</h2>
        <p>
          P-Dot stores your data in a Supabase Postgres database. Each row belongs to one account, and database rules
          let only that account read it. P-Dot stores:
        </p>
        <ul>
          <li>Your email address and sign-in details, or an anonymous trial account.</li>
          <li>Your conversations and the replies.</li>
          <li>The memories, documents, tasks and reminders that you add or approve.</li>
          <li>
            Each action that P-Dot proposes, and a log of what you approved, cancelled or changed. The log keeps kinds,
            counts and IDs.
          </li>
          <li>
            For each reply, a &ldquo;What was sent&rdquo; record: the model, how many messages, which memories and
            documents, and the web sources.
          </li>
          <li>If you connect Google, Notion, Linear or Todoist: the access tokens, stored encrypted.</li>
        </ul>
      </section>

      <section>
        <h2>Who receives your text</h2>
        <ul>
          <li>
            <strong>Nebius</strong> runs the NVIDIA Nemotron models. It receives your message, recent messages from the
            conversation, and the memories, document parts, web results and app data that the reply uses. It also
            receives memory and document text to make search vectors.
          </li>
          <li>
            <strong>Tavily</strong> receives a search query when web search is on. The query comes from your message.
          </li>
          <li>
            <strong>Google</strong> (Gmail and Calendar), <strong>Notion</strong>, <strong>Linear</strong> and{" "}
            <strong>Todoist</strong>: P-Dot reads them only after you connect them, and only when you turn them on for
            a message. P-Dot changes Google only after you approve a card, for example to add a calendar event.
          </li>
          <li>
            <strong>Cloudflare</strong> hosts the site, so your requests go through it.
          </li>
        </ul>
        <p>
          P-Dot does not sell your data and shows no ads. The server logs do not keep your messages, tokens or search
          queries.
        </p>
      </section>

      <section>
        <h2>Delete and clean up</h2>
        <ul>
          <li>Delete a conversation in the chat list. Its messages go from the database at once.</li>
          <li>Delete a memory or a document on the Memory page. Its text and search vector go at once.</li>
          <li>Disconnect Google or an app on the Connectors page.</li>
          <li>The Activity record and the action proposals stay as an audit record.</li>
          <li>Database backups can keep a copy until they expire under the hosting plan.</li>
          <li>Trial accounts and their data are deleted by 31 January 2027.</li>
          <li>
            You cannot delete your account in the app yet. To ask for a delete, open an issue on the{" "}
            <a href="https://github.com/PATELOM925/P-Dot/issues" rel="noopener noreferrer">
              project page
            </a>{" "}
            without personal details, and the owner contacts you.
          </li>
        </ul>
      </section>
    </LegalPage>
  );
}
