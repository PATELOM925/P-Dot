import { routeSummary } from "@/lib/routing";
import { toSafeHttpUrl } from "@/lib/safe-url";
import type { MessageDTO, SourceRef, WebSearchStatus } from "@/types/api";
import { Markdown } from "./markdown/Markdown";
import { WhatWasSent } from "./WhatWasSent";

export interface UiMessage extends MessageDTO {
  /** Shown optimistically before the server confirms it was saved. */
  pending?: boolean;
  truncated?: boolean;
}

const SEARCH_NOTICES: Partial<Record<WebSearchStatus, string>> = {
  failed: "Web search failed, so this answer is not based on web sources.",
  no_results: "Web search found no usable results, so this answer is not based on web sources.",
};

export function SearchNotice({ status, message }: { status: WebSearchStatus; message?: string }) {
  const text = message ?? SEARCH_NOTICES[status];
  if (!text || status === "used" || status === "off") return null;
  return <p className="alert alert-warning small">{text}</p>;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function SourceList({ sources }: { sources: SourceRef[] }) {
  // Each source keeps its place, so the numbers match the [n] marks in the reply. An unsafe link is removed, not the source.
  const safe = sources.map((source) => ({ title: source.title, url: toSafeHttpUrl(source.url) }));
  if (safe.length === 0) return null;

  return (
    <aside className="sources" aria-label="Web sources">
      <p className="sources-title">Web sources retrieved for this answer</p>
      <p className="hint">
        These pages were given to the assistant as context. The answer above is the assistant&apos;s
        interpretation and may not be supported by every source.
      </p>
      <ol>
        {safe.map((source, index) =>
          source.url ? (
            <li key={index}>
              <a href={source.url} target="_blank" rel="noopener noreferrer nofollow">
                {source.title}
              </a>{" "}
              <span className="hint">{hostname(source.url)}</span>
            </li>
          ) : (
            <li key={index}>
              {source.title} <span className="hint">Link removed</span>
            </li>
          ),
        )}
      </ol>
    </aside>
  );
}

export function MessageItem({ message }: { message: UiMessage }) {
  const isUser = message.role === "user";
  return (
    <article className={`message ${isUser ? "message-user" : "message-assistant"}`}>
      <p className="message-author">{isUser ? "You" : "P-Dot"}</p>
      {!isUser && <SearchNotice status={message.webSearch} />}
      {/* User text stays plain text. Replies are safe Markdown: React elements, never HTML. */}
      {isUser ? <div className="message-content message-plain">{message.content}</div> : <Markdown text={message.content} />}
      {message.pending && <p className="hint">Sending…</p>}
      {message.truncated && (
        <p className="hint">This reply reached the length limit and may be incomplete. To get the rest, send “continue”.</p>
      )}
      {!isUser && message.webSearch === "used" && <SourceList sources={message.sources} />}
      {!isUser && (
        <div className="message-footer">
          {message.route && (
            <p className="message-route" title={`Model tier: ${message.route.tier}`}>
              {routeSummary(message.route)}
            </p>
          )}
          <WhatWasSent messageId={message.id} createdAt={message.createdAt} />
        </div>
      )}
    </article>
  );
}
