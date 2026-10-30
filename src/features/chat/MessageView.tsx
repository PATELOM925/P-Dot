import { routeSummary } from "@/lib/routing";
import type { MessageDTO, WebSearchStatus } from "@/types/api";
import { AssistantReply } from "./AssistantReply";
import { TURN_STATE_LABELS, type TurnState } from "./turn-state";
import { WhatWasSent } from "./WhatWasSent";

export interface UiMessage extends MessageDTO {
  /** Shown optimistically before the server confirms it was saved. */
  pending?: boolean;
  truncated?: boolean;
  /** A reply the user stopped. Kept on this screen only; the server has no copy. */
  stopped?: boolean;
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

export function MessageItem({ message, state }: { message: UiMessage; state?: TurnState }) {
  const isUser = message.role === "user";
  if (message.stopped) {
    return (
      <article className="message message-assistant message-partial">
        <p className="message-author">P-Dot</p>
        <p className="turn-state" data-state="stopped">
          You stopped this reply. It is not saved.
        </p>
        <AssistantReply text={message.content} sources={[]} messageId={message.id} showSources={false} />
      </article>
    );
  }
  return (
    <article className={`message ${isUser ? "message-user" : "message-assistant"}`}>
      <p className="message-author">{isUser ? "You" : "P-Dot"}</p>
      {!isUser && <SearchNotice status={message.webSearch} />}
      {/* User text stays plain text. Replies are safe Markdown: React elements, never HTML. */}
      {isUser ? (
        <div className="message-content message-plain">{message.content}</div>
      ) : (
        <AssistantReply
          text={message.content}
          sources={message.sources}
          messageId={message.id}
          showSources={message.webSearch === "used"}
        />
      )}
      {message.pending && <p className="hint">Sending…</p>}
      {message.truncated && (
        <p className="hint">This reply reached the length limit and may be incomplete. To get the rest, send “continue”.</p>
      )}
      {!isUser && (
        <div className="message-footer">
          {state && (
            <p className="turn-state" data-state={state}>
              {TURN_STATE_LABELS[state]}
            </p>
          )}
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
