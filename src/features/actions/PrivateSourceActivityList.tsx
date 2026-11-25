"use client";

import { useState } from "react";
import { ApiError, errorMessage, getJson } from "@/lib/api-client";
import type { PrivateSourceActivityDTO } from "@/types/api";
import { LocalTime } from "@/components/ui/LocalTime";
import Link from "next/link";

function sourceLabel(source: PrivateSourceActivityDTO["source"]): string {
  if (source === "assistant_search") return "Assistant web search was blocked by the private-source policy";
  return source === "google" ? "Google data was read successfully" : "Connected app data was read successfully";
}

export function PrivateSourceActivityList({ initialEntries }: { initialEntries: PrivateSourceActivityDTO[] }) {
  const [entries, setEntries] = useState(initialEntries);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const response = await getJson<{ entries: PrivateSourceActivityDTO[] }>("/api/activity-policy");
      setEntries(response.entries);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError("Sign in again to refresh Activity.");
      else setError(errorMessage(err, "Could not refresh privacy activity."));
    } finally {
      setLoading(false);
    }
  }

  if (entries.length === 0 && !loading && !error) return null;
  return (
    <section className="panel" aria-labelledby="privacy-activity-heading" aria-busy={loading}>
      <div className="panel-heading">
        <h2 id="privacy-activity-heading">Connected source and privacy policy</h2>
        <button type="button" className="button button-small" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="small muted">
        These entries record successful private-source reads and an assistant web search refused by policy. Selecting
        a source alone does not create a read entry. After a private-source reply, assistant-initiated web searches
        stay off in that conversation; the separate web-search switch can still search with your own words.
      </p>
      <p className="small muted">These are conversation-history metadata, not protected audit records. They are removed when you delete the conversation. Action history below is stored separately.</p>
      {error && <p className="alert alert-error small" role="alert">{error}</p>}
      <ol className="log-list">
        {entries.map((entry) => (
          <li key={entry.id} className="log-entry">
            <span className="log-time"><LocalTime iso={entry.createdAt} style="time" /></span>
            <span className="log-body">
              <span className="log-title">{sourceLabel(entry.source)}</span>
              <span className="hint">{entry.outcome === "search_blocked" ? "No search was sent." : "Recorded from the completed provider read."}</span>
              <Link className="small" href={`/chat?c=${encodeURIComponent(entry.conversationId)}`}>Open conversation</Link>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
