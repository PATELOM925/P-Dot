"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_MESSAGE_CHARS } from "@/lib/limits";
import type { ChatRequest, ConversationSummary, Effort, Mode, ModelTier, SourceRef, WebSearchStatus } from "@/types/api";
import {
  ApiError,
  deleteConversation,
  fetchConversation,
  fetchConversations,
  postChat,
  renameConversation,
} from "./api";
import { MessageItem, SearchNotice, SourceList, type UiMessage } from "./MessageView";
import { readChatStream } from "./stream";
import { useDictation } from "./useDictation";

interface StreamingReply {
  text: string;
  search: { status: Exclude<WebSearchStatus, "off">; sources: SourceRef[]; message?: string } | null;
  /** The tier from the start event, before the first token. */
  tier?: ModelTier;
}

const EFFORT_OPTIONS: { value: Effort; label: string; title: string }[] = [
  { value: "auto", label: "Auto", title: "P-Dot chooses a model for each message." },
  {
    value: "deep",
    label: "Think harder",
    title: "Use the strongest model. It is slower and uses more of the daily limit.",
  },
];

interface ErrorState {
  message: string;
}

function syncUrl(conversationId: string | null) {
  window.history.replaceState(null, "", conversationId ? `/chat?c=${encodeURIComponent(conversationId)}` : "/chat");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

const EMPTY_HINTS: Record<Mode, string> = {
  personal: "Ask about meals, gifts, family plans, errands or everyday choices.",
  work: "Ask about meetings, email, code, tasks, deadlines or work writing.",
};

export function ChatWorkspace({
  initialConversationId,
  mode,
}: {
  initialConversationId: string | null;
  mode: Mode;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [activeId, setActiveId] = useState<string | null>(initialConversationId);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(initialConversationId !== null);
  const [draft, setDraft] = useState("");
  const [webSearch, setWebSearch] = useState(false);
  const [effort, setEffort] = useState<Effort>("auto");
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState<StreamingReply | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [status, setStatus] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [savingRename, setSavingRename] = useState(false);

  const dictation = useDictation(
    useCallback((text: string) => setDraft((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text)), []),
  );

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
    fetchConversations(mode)
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
  }, [initialConversationId, loadMessages, mode, redirectIfUnauthorized]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming]);

  function openConversation(id: string) {
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
        ? { action, message: text, webSearch, effort, ...(activeId ? { conversationId: activeId } : { mode }) }
        : { action, conversationId: activeId!, webSearch, effort };

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
          route: null,
          createdAt: new Date().toISOString(),
          pending: true,
        },
      ]);
    }

    try {
      const stream = await postChat(body, controller.signal);
      for await (const event of readChatStream(stream)) {
        switch (event.type) {
          case "start":
            accepted = true;
            setActiveId(event.conversation.id);
            syncUrl(event.conversation.id);
            setConversations((list) => [event.conversation, ...list.filter((c) => c.id !== event.conversation.id)]);
            if (action === "send") {
              setMessages((current) => current.map((m) => (m.id === tempId ? event.userMessage : m)));
            }
            setStreaming((current) => ({
              text: current?.text ?? "",
              search: current?.search ?? null,
              tier: event.route.tier,
            }));
            setStatus(webSearch ? "Searching the web…" : "P-Dot is replying…");
            break;
          case "search":
            setStreaming((current) => ({
              text: current?.text ?? "",
              search: { status: event.status, sources: event.sources, message: event.message },
              tier: current?.tier,
            }));
            setStatus(event.status === "used" ? "Web search complete. P-Dot is replying…" : (event.message ?? ""));
            break;
          case "delta":
            setStreaming((current) => ({
              text: (current?.text ?? "") + event.text,
              search: current?.search ?? null,
              tier: current?.tier,
            }));
            break;
          case "done":
            finished = true;
            setMessages((current) => [...current, { ...event.message, truncated: event.truncated }]);
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

  function startRename(conversation: ConversationSummary) {
    setConfirmDeleteId(null);
    setRenamingId(conversation.id);
    setRenameValue(conversation.title);
  }

  async function saveRename(id: string) {
    const title = renameValue.trim();
    if (!title || savingRename) return;
    setSavingRename(true);
    try {
      const renamed = await renameConversation(id, title);
      setConversations((list) => list.map((c) => (c.id === id ? { ...c, title: renamed.title } : c)));
      setRenamingId(null);
      setStatus("Conversation renamed.");
    } catch (err) {
      if (redirectIfUnauthorized(err)) return;
      setError({ message: err instanceof Error ? err.message : "Could not rename the conversation." });
    } finally {
      setSavingRename(false);
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
              {renamingId === conversation.id ? (
                <form
                  className="rename-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveRename(conversation.id);
                  }}
                >
                  <label htmlFor={`rename-${conversation.id}`} className="visually-hidden">
                    Conversation name
                  </label>
                  <input
                    id={`rename-${conversation.id}`}
                    type="text"
                    value={renameValue}
                    maxLength={120}
                    autoFocus
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => event.key === "Escape" && setRenamingId(null)}
                  />
                  <button
                    type="submit"
                    className="icon-button"
                    aria-label="Save name"
                    disabled={savingRename || !renameValue.trim()}
                  >
                    ✓
                  </button>
                  <button type="button" className="icon-button" aria-label="Cancel rename" onClick={() => setRenamingId(null)}>
                    ×
                  </button>
                </form>
              ) : confirmDeleteId === conversation.id ? (
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
                    onClick={() => startRename(conversation)}
                    aria-label={`Rename “${conversation.title}”`}
                    title="Rename conversation"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="icon-button icon-button-danger"
                    onClick={() => {
                      setRenamingId(null);
                      setConfirmDeleteId(conversation.id);
                    }}
                    aria-label={`Delete “${conversation.title}”`}
                    title="Delete conversation"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                    </svg>
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
              <p>{EMPTY_HINTS[mode]}</p>
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
                {streaming.text || (
                  <span className="muted">
                    {webSearch && !streaming.search
                      ? "Searching the web…"
                      : streaming.tier === "heavy"
                        ? "Thinking harder…"
                        : "Thinking…"}
                  </span>
                )}
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
          <div className="composer-box">
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
              rows={2}
              maxLength={MAX_MESSAGE_CHARS}
              placeholder="Ask P-Dot anything…"
              aria-describedby="composer-hint"
            />
            <div className="composer-bar">
              <div className="tools-anchor">
                {toolsOpen && (
                  <div
                    id="composer-tools"
                    className="tools-menu"
                    onKeyDown={(event) => event.key === "Escape" && setToolsOpen(false)}
                  >
                    <label className="tool-option">
                      <input type="checkbox" checked={webSearch} onChange={(event) => setWebSearch(event.target.checked)} />
                      <span>
                        <strong>Search the web</strong>
                        <span className="hint">Powered by Tavily. Off unless you turn it on.</span>
                      </span>
                    </label>
                  </div>
                )}
                <button
                  type="button"
                  className="round-button"
                  aria-label="Add tools"
                  aria-expanded={toolsOpen}
                  aria-controls="composer-tools"
                  onClick={() => setToolsOpen((open) => !open)}
                >
                  +
                </button>
              </div>
              <div role="group" aria-label="Effort" className="mode-toggle effort-toggle">
                {EFFORT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="mode-option"
                    aria-pressed={effort === option.value}
                    title={option.title}
                    onClick={() => setEffort(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {webSearch && (
                <button
                  type="button"
                  className="chip chip-button"
                  onClick={() => setWebSearch(false)}
                  aria-label="Web search with Tavily is on. Turn off."
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
                  </svg>
                  Web search · Tavily ×
                </button>
              )}
              <span id="composer-hint" className="hint composer-hint">
                {draft.length > MAX_MESSAGE_CHARS * 0.9
                  ? `${draft.length} / ${MAX_MESSAGE_CHARS} characters`
                  : "Enter to send · Shift+Enter for a new line"}
              </span>
              <button
                type="button"
                className={`round-button${dictation.listening ? " is-listening" : ""}`}
                aria-label={dictation.listening ? "Stop dictating" : "Dictate a message (speech to English text)"}
                aria-pressed={dictation.listening}
                title={
                  dictation.supported
                    ? "Speak and P-Dot writes it as English text"
                    : "Dictation is not supported in this browser"
                }
                disabled={!dictation.supported}
                onClick={dictation.toggle}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                </svg>
              </button>
              {sending ? (
                <button type="button" className="round-button round-button-solid" aria-label="Stop" onClick={() => abortRef.current?.abort()}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button type="submit" className="round-button round-button-solid" aria-label="Send message" disabled={!draft.trim()}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          {dictation.error && (
            <p className="alert alert-warning small" role="alert">
              {dictation.error}
            </p>
          )}
          <p className="disclaimer">P-Dot is an AI and can make mistakes, so please double-check anything important.</p>
        </form>

        <p className="visually-hidden" role="status" aria-live="polite">
          {status}
        </p>
      </main>
    </div>
  );
}
