"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_MESSAGE_CHARS } from "@/lib/limits";
import type { ChatRequest, ConversationSummary, SourceRef, WebSearchStatus } from "@/types/api";
import { ApiError, deleteConversation, fetchConversation, fetchConversations, postChat } from "./api";
import { MessageItem, SearchNotice, SourceList, type UiMessage } from "./MessageView";
import { readChatStream } from "./stream";

interface StreamingReply {
  text: string;
  search: { status: Exclude<WebSearchStatus, "off">; sources: SourceRef[]; message?: string } | null;
}

interface ErrorState {
  message: string;
}

function syncUrl(conversationId: string | null) {
  window.history.replaceState(null, "", conversationId ? `/chat?c=${encodeURIComponent(conversationId)}` : "/chat");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function ChatWorkspace({ initialConversationId }: { initialConversationId: string | null }) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [activeId, setActiveId] = useState<string | null>(initialConversationId);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(initialConversationId !== null);
  const [draft, setDraft] = useState("");
  const [webSearch, setWebSearch] = useState(false);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState<StreamingReply | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [status, setStatus] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);

  const router = useRouter();
  const abortRef = useRef<AbortController | null>(null);
  const loadSeq = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const redirectIfUnauthorized = useCallback(
    (error: unknown): boolean => {
      if (error instanceof ApiError && error.status === 401) {
        router.replace("/login?next=/chat");
        return true;
      }
      return false;
    },
    [router],
  );

  const loadMessages = useCallback(
    (id: string) => {
      const seq = ++loadSeq.current;
      return fetchConversation(id).then(
        (detail) => {
          if (seq !== loadSeq.current) return;
          setMessages(detail.messages);
          setLoadingMessages(false);
        },
        (err: unknown) => {
          if (seq !== loadSeq.current || redirectIfUnauthorized(err)) return;
          setLoadingMessages(false);
          if (err instanceof ApiError && err.status === 404) {
            setActiveId(null);
            syncUrl(null);
            setError({ message: "That conversation was not found. It may have been deleted." });
          } else {
            setError({ message: err instanceof Error ? err.message : "Could not load the conversation." });
          }
        },
      );
    },
    [redirectIfUnauthorized],
  );

  useEffect(() => {
    let cancelled = false;
    fetchConversations()
      .then((list) => {
        if (cancelled) return;
        setConversations(list);
        setListState("ready");
      })
      .catch((err: unknown) => {
        if (!cancelled && !redirectIfUnauthorized(err)) setListState("error");
      });
    if (initialConversationId) void loadMessages(initialConversationId);
    return () => {
      cancelled = true;
    };
  }, [initialConversationId, loadMessages, redirectIfUnauthorized]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming]);

  function triggerSessionSummarize(conversationId: string | null) {
    if (!conversationId) return;
    void fetch("/api/memories/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
    }).catch(() => {
      // Best-effort background summarization
    });
  }

  function openConversation(id: string) {
    if (activeId && activeId !== id && messages.length >= 2) {
      triggerSessionSummarize(activeId);
    }
    abortRef.current?.abort();
    setActiveId(id);
    setMessages([]);
    setError(null);
    setConfirmDeleteId(null);
    setShowList(false);
    setLoadingMessages(true);
    syncUrl(id);
    void loadMessages(id);
  }

  function startNewConversation() {
    if (activeId && messages.length >= 2) {
      triggerSessionSummarize(activeId);
    }
    abortRef.current?.abort();
    loadSeq.current += 1;
    setActiveId(null);
    setMessages([]);
    setError(null);
    setLoadingMessages(false);
    setShowList(false);
    syncUrl(null);
    inputRef.current?.focus();
  }

  async function submit(action: "send" | "retry") {
    if (sending) return;
    const text = draft.trim();
    if (action === "send" && (!text || text.length > MAX_MESSAGE_CHARS)) return;
    if (action === "retry" && !activeId) return;

    const body: ChatRequest =
      action === "send"
        ? { action, message: text, webSearch, ...(activeId ? { conversationId: activeId } : {}) }
        : { action, conversationId: activeId!, webSearch };

    const controller = new AbortController();
    abortRef.current = controller;
    const tempId = `pending-${Date.now()}`;
    let accepted = false;
    let finished = false;

    const restoreDraft = () => {
      if (action !== "send") return;
      setMessages((current) => current.filter((message) => message.id !== tempId));
      setDraft((current) => (current ? current : text));
    };

    setSending(true);
    setError(null);
    setStreaming({ text: "", search: null });
    setStatus("Sending…");
    if (action === "send") {
      setDraft("");
      setMessages((current) => [
        ...current,
        {
          id: tempId,
          role: "user",
          content: text,
          webSearch: "off",
          sources: [],
          createdAt: new Date().toISOString(),
          pending: true,
        },
      ]);
    }

    let currentConversationId = activeId;

    try {
      const stream = await postChat(body, controller.signal);
      for await (const event of readChatStream(stream)) {
        switch (event.type) {
          case "start":
            accepted = true;
            currentConversationId = event.conversation.id;
            setActiveId(event.conversation.id);
            syncUrl(event.conversation.id);
            setConversations((list) => [event.conversation, ...list.filter((c) => c.id !== event.conversation.id)]);
            if (action === "send") {
              setMessages((current) => current.map((m) => (m.id === tempId ? event.userMessage : m)));
            }
            setStatus(webSearch ? "Searching the web…" : "P-Dot is replying…");
            break;
          case "search":
            setStreaming((current) => ({
              text: current?.text ?? "",
              search: { status: event.status, sources: event.sources, message: event.message },
            }));
            setStatus(event.status === "used" ? "Web search complete. P-Dot is replying…" : (event.message ?? ""));
            break;
          case "thought":
            setStatus(`💭 ${event.text}`);
            break;
          case "action":
            setStatus(`Proposed ${event.action.kind}: "${event.action.title}"`);
            break;
          case "delta":
            setStreaming((current) => ({ text: (current?.text ?? "") + event.text, search: current?.search ?? null }));
            break;
          case "title":
            setConversations((list) =>
              list.map((c) => (c.id === (currentConversationId ?? activeId) ? { ...c, title: event.title } : c))
            );
            break;
          case "done":
            finished = true;
            setMessages((current) => {
              const updated = [...current, { ...event.message, truncated: event.truncated }];
              if (currentConversationId && updated.length >= 6 && updated.length % 6 === 0) {
                triggerSessionSummarize(currentConversationId);
              }
              return updated;
            });
            setStreaming(null);
            setStatus("Reply complete.");
            break;
          case "error":
            finished = true;
            setStreaming(null);
            setError({ message: event.message });
            setStatus("");
            break;
        }
      }
      if (!finished) {
        setStreaming(null);
        setError({ message: "The reply was interrupted. Please retry." });
      }
    } catch (err) {
      setStreaming(null);
      if (isAbort(err)) {
        if (!accepted) restoreDraft();
        setStatus("Stopped.");
      } else if (!redirectIfUnauthorized(err)) {
        if (!accepted) restoreDraft();
        setError({ message: err instanceof Error ? err.message : "Something went wrong. Please retry." });
        setStatus("");
      }
    } finally {
      setSending(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  async function confirmDelete(id: string) {
    setDeletingId(id);
    try {
      await deleteConversation(id);
    } catch (err) {
      if (redirectIfUnauthorized(err)) return;
      // 404 means it is already gone; anything else is a real failure.
      if (!(err instanceof ApiError && err.status === 404)) {
        setError({ message: "Could not delete the conversation. Please retry." });
        setDeletingId(null);
        return;
      }
    }
    setConversations((list) => list.filter((c) => c.id !== id));
    if (activeId === id) startNewConversation();
    setConfirmDeleteId(null);
    setDeletingId(null);
    setStatus("Conversation deleted.");
  }

  const last = messages.at(-1);
  const canRetry = !sending && !loadingMessages && activeId !== null && last?.role === "user" && !last.pending;
  const activeTitle = conversations.find((c) => c.id === activeId)?.title;

  return (
    <div className="chat-layout">
      <aside className={`chat-sidebar${showList ? " is-open" : ""}`} aria-label="Conversations">
        <button type="button" className="button button-primary" onClick={startNewConversation}>
          New conversation
        </button>
        {listState === "loading" && <p className="muted small">Loading conversations…</p>}
        {listState === "error" && (
          <p className="alert alert-error small" role="alert">
            Could not load your conversations.
          </p>
        )}
        {listState === "ready" && conversations.length === 0 && (
          <p className="muted small">No conversations yet.</p>
        )}
        <ul className="conversation-list">
          {conversations.map((conversation) => (
            <li key={conversation.id} className={conversation.id === activeId ? "is-active" : undefined}>
              {confirmDeleteId === conversation.id ? (
                <div className="confirm-delete" role="group" aria-label={`Delete “${conversation.title}”?`}>
                  <span className="small">Delete this conversation permanently?</span>
                  <div className="actions">
                    <button
                      type="button"
                      className="button button-danger button-small"
                      onClick={() => void confirmDelete(conversation.id)}
                      disabled={deletingId === conversation.id}
                    >
                      {deletingId === conversation.id ? "Deleting…" : "Delete"}
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => setConfirmDeleteId(null)}
                      disabled={deletingId === conversation.id}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="conversation-link"
                    onClick={() => openConversation(conversation.id)}
                    aria-current={conversation.id === activeId ? "true" : undefined}
                  >
                    {conversation.title}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setConfirmDeleteId(conversation.id)}
                    aria-label={`Delete “${conversation.title}”`}
                    title="Delete conversation"
                  >
                    ×
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </aside>

      <main className="chat-main">
        <div className="chat-toolbar">
          <button
            type="button"
            className="button button-small mobile-only"
            aria-expanded={showList}
            onClick={() => setShowList((open) => !open)}
          >
            Conversations
          </button>
          <h1 className="chat-title">{activeTitle ?? (activeId ? "Conversation" : "New conversation")}</h1>
        </div>

        <div className="message-list">
          {loadingMessages && <p className="muted">Loading conversation…</p>}
          {!loadingMessages && messages.length === 0 && !streaming && (
            <div className="empty-state">
              <p>Ask a question, research a topic, draft something, or plan your day.</p>
              <p className="muted small">Turn on web search when you want current sources.</p>
            </div>
          )}
          {messages.map((message) => (
            <MessageItem key={message.id} message={message} />
          ))}
          {streaming && (
            <article className="message message-assistant" aria-busy="true">
              <p className="message-author">P-Dot</p>
              {streaming.search && <SearchNotice status={streaming.search.status} message={streaming.search.message} />}
              <div className="message-content">
                {streaming.text || <span className="muted">{webSearch && !streaming.search ? "Searching the web…" : "Thinking…"}</span>}
              </div>
              {streaming.search?.status === "used" && <SourceList sources={streaming.search.sources} />}
            </article>
          )}
          <div ref={endRef} />
        </div>

        {error && (
          <div className="alert alert-error chat-error" role="alert">
            <span>{error.message}</span>
          </div>
        )}
        {canRetry && (
          <div className="retry-bar">
            <span className="small muted">This message has no reply yet.</span>
            <button type="button" className="button button-small" onClick={() => void submit("retry")}>
              Retry reply
            </button>
          </div>
        )}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit("send");
          }}
        >
          <label htmlFor="composer-input" className="visually-hidden">
            Message
          </label>
          <textarea
            id="composer-input"
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit("send");
              }
            }}
            rows={3}
            maxLength={MAX_MESSAGE_CHARS}
            placeholder="Ask P-Dot anything…"
            aria-describedby="composer-hint"
          />
          <div className="composer-bar">
            <label className="toggle">
              <input type="checkbox" checked={webSearch} onChange={(event) => setWebSearch(event.target.checked)} />
              Search the web
            </label>
            <span id="composer-hint" className="hint">
              {draft.length > MAX_MESSAGE_CHARS * 0.9
                ? `${draft.length} / ${MAX_MESSAGE_CHARS} characters`
                : "Enter to send · Shift+Enter for a new line"}
            </span>
            {sending ? (
              <button type="button" className="button" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="submit" className="button button-primary" disabled={!draft.trim()}>
                Send
              </button>
            )}
          </div>
        </form>

        <p className="visually-hidden" role="status" aria-live="polite">
          {status}
        </p>
      </main>
    </div>
  );
}
