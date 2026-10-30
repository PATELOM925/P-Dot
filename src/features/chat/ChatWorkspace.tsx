"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ApprovalModeMenu, ApprovalModeSetup } from "@/features/actions/ApprovalModePicker";
import { useModal } from "@/components/ui/useModal";
import { useApprovalMode } from "@/features/actions/approval-mode";
import { notifyActionsChanged } from "@/features/actions/events";
import { useAutoApprovals } from "@/features/actions/useAutoApprovals";
import { useProposals } from "@/features/actions/useProposals";
import { useMemorySuggestions, type MemorySuggestion } from "@/features/memory/useMemorySuggestions";
import { MCP_SERVER_NAMES, type McpServerId } from "@/lib/connectors";
import { MAX_MESSAGE_CHARS } from "@/lib/limits";
import type {
  ActionProposalDTO,
  ChatRequest,
  ConversationSummary,
  Effort,
  Mode,
  ModelTier,
  SourceRef,
  WebSearchStatus,
} from "@/types/api";
import {
  ApiError,
  deleteConversation,
  fetchConversation,
  fetchConversations,
  postChat,
  renameConversation,
} from "./api";
import { Markdown } from "./markdown/Markdown";
import { AssistantReply } from "./AssistantReply";
import { MessageItem, SearchNotice, type UiMessage } from "./MessageView";
import { ToolChips, ToolsMenu, type ToolItem } from "./ComposerTools";
import { autoSources, googleToolItem, toggleSource, type GoogleChatState, type MessageSources } from "./composer-sources";
import { TurnExtras } from "./TurnExtras";
import { effortAfterAccept } from "./effort";
import { placeBySource, placeByTime } from "./placement";
import { composerLimit } from "./composer-limit";
import { ChatSendKey } from "./send-key";
import { StarterPrompts } from "./StarterPrompts";
import type { StarterPrompt } from "./starter-prompts";
import { readChatStream } from "./stream";
import { toolStatusLine } from "./tool-status";
import { browserTimeZone } from "@/lib/time-zone";
import {
  STALL_LINE,
  STALL_MS,
  turnStepLine,
  blocksRetry,
  canRetryLast,
  chatErrorView,
  withNoRetry,
  type TurnState,
} from "./turn-state";
import { appendDictation, useDictation } from "./useDictation";
import { useStickToBottom } from "./useStickToBottom";
import { orderByPins, usePins, useSidebarCollapsed } from "./sidebar-prefs";

interface StreamingReply {
  text: string;
  search: { status: Exclude<WebSearchStatus, "off">; sources: SourceRef[]; message?: string } | null;
  /** The tier from the start event, before the first token. */
  tier?: ModelTier;
  /** The tool that runs now, until the next search result or text arrives. */
  tool?: string;
}

interface ErrorState {
  message: string;
  retryable?: boolean;
  limit?: boolean;
  /** Text that streamed before the failure. It is shown muted and is not saved. */
  partial?: string;
  /** The error belongs to a send or a retry, so it shows under that turn. */
  turn?: boolean;
}

function syncUrl(conversationId: string | null) {
  window.history.replaceState(null, "", conversationId ? `/chat?c=${encodeURIComponent(conversationId)}` : "/chat");
}

/** Event handlers only. */
const now = () => Date.now();

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

const EMPTY_TITLES: Record<Mode, string> = {
  personal: "Ask, plan, or set a reminder.",
  work: "Draft, plan, or track a deadline.",
};

export function ChatWorkspace({
  userId,
  initialConversationId,
  mode,
  google = null,
  trial = false,
  connectedApps = [],
}: {
  /** Keys this device's pinned conversations to the signed-in user. */
  userId: string;
  initialConversationId: string | null;
  mode: Mode;
  google?: GoogleChatState;
  /** A trial user (decision 0015): limit errors say so. */
  trial?: boolean;
  /** Apps the user connected that chat can read. Read on the server. */
  connectedApps?: McpServerId[];
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [activeId, setActiveId] = useState<string | null>(initialConversationId);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(initialConversationId !== null);
  const [draft, setDraft] = useState("");
  const [webSearch, setWebSearch] = useState(false);
  // Deep research for the next message only (decision 0018). Web search is on with it.
  const [research, setResearch] = useState(false);
  // True while the tools on come from a starter prompt, so clearing its text turns them off.
  const starterToolsRef = useRef(false);
  // The sources of the last sent message, so Retry uses them and not the composer's next pick.
  const lastSentRef = useRef<{ conversationId: string | null; sources: MessageSources } | null>(null);
  // One message only; it turns off at Send. `toggleSource` keeps one kind of source on at a time.
  const [useGoogle, setUseGoogle] = useState(false);
  // Apps to read for the next message only.
  const [apps, setApps] = useState<McpServerId[]>([]);
  // True once the user picks or turns off a source for this draft: the auto pick then stays off.
  const [autoOff, setAutoOff] = useState(false);
  const [effort, setEffort] = useState<Effort>("auto");
  // Counts the user's clicks on the effort switch, so a late "start" event cannot undo a newer choice.
  const effortVersion = useRef(0);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState<StreamingReply | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [stopped, setStopped] = useState<{ partial: string } | null>(null);
  // User messages whose last error said Retry cannot help, for the whole page session.
  const [noRetryIds, setNoRetryIds] = useState<ReadonlySet<string>>(() => new Set());
  // "Working" only while events arrive (spec D1): the time of the last stream event, and whether it is too long ago.
  const lastEventRef = useRef(0);
  const streamTextRef = useRef("");
  const [stalled, setStalled] = useState(false);
  const stalledRef = useRef(false);
  const leftStreamRef = useRef<AbortController | null>(null);
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerBackdropRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed();
  const pins = usePins(userId);
  // One composer menu at a time.
  const [openMenu, setOpenMenu] = useState<"tools" | "approval" | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  // Bumped after each reply so P-Dot's suggestions reload; a reply may come with new proposals or memories.
  const [suggestionsKey, setSuggestionsKey] = useState(0);
  // "Ask first" or "Auto". Auto acts only on replies to messages sent while it was on (their user message IDs).
  const approvalMode = useApprovalMode();
  const [autoTurns, setAutoTurns] = useState<ReadonlySet<string>>(() => new Set());

  const dictation = useDictation(
    useCallback((text: string) => setDraft((current) => appendDictation(current, text, MAX_MESSAGE_CHARS)), []),
  );

  const router = useRouter();
  // The request key of the draft: a resend of the same draft after an error uses the same key.
  const [sendKey] = useState(() => new ChatSendKey());
  const abortRef = useRef<AbortController | null>(null);
  const loadSeq = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
  const goToLogin = useCallback(() => router.replace("/login?next=/chat"), [router]);

  // P-Dot's suggestions (actions to approve, memories to keep), shown under the reply they came from.
  const suggestionsRefresh = `${activeId ?? ""}:${suggestionsKey}`;
  const actions = useProposals({ refreshKey: suggestionsRefresh, enabled: activeId !== null, onUnauthorized: goToLogin });
  const memorySuggestions = useMemorySuggestions({
    mode,
    refreshKey: suggestionsRefresh,
    enabled: activeId !== null,
    onUnauthorized: goToLogin,
  });

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

  // Follow the reply only while the user is at the bottom; otherwise offer "Jump to latest".
  const stick = useStickToBottom(listRef, [messages, streaming, stopped, error]);

  useEffect(() => {
    if (!sending) return;
    const timer = window.setInterval(() => {
      if (stalledRef.current || now() - lastEventRef.current < STALL_MS) return;
      stalledRef.current = true;
      setStalled(true);
      setStatus(STALL_LINE);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [sending]);

  function showTurnError(view: Omit<ErrorState, "turn">, userMessageId: string | null) {
    setError({ ...view, turn: true });
    // A limit is not final: Retry can work later. Only an error that says Retry cannot help blocks it.
    if (blocksRetry(view) && userMessageId) setNoRetryIds((ids) => withNoRetry(ids, userMessageId));
  }

  function closeList() {
    setShowList(false);
  }

  // The phone drawer: focus goes to its Close button, and Esc closes it. On close, focus goes back to
  // the toggle, after the render that takes `inert` off the chat.
  useModal(showList, drawerRef, drawerBackdropRef);
  const drawerWasOpen = useRef(false);
  useEffect(() => {
    if (!showList) {
      if (drawerWasOpen.current) drawerToggleRef.current?.focus();
      drawerWasOpen.current = false;
      return;
    }
    drawerWasOpen.current = true;
    drawerCloseRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowList(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showList]);

  /** Stops a reply because the user leaves its conversation. That is not a "Stopped" turn to show. */
  function leaveStream() {
    if (abortRef.current) leftStreamRef.current = abortRef.current;
    abortRef.current?.abort();
    setStopped(null);
  }

  function openConversation(id: string) {
    leaveStream();
    // Words still being dictated belong to the conversation the user is leaving.
    dictation.cancel();
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
    leaveStream();
    dictation.cancel();
    loadSeq.current += 1;
    setActiveId(null);
    setMessages([]);
    setError(null);
    setLoadingMessages(false);
    setShowList(false);
    syncUrl(null);
    inputRef.current?.focus();
  }

  /**
   * After a 409 "answered": the message is already saved. Opens its conversation,
   * and when a saved user message has the draft text, the draft was sent: clear it.
   */
  async function showSavedMessage(conversationId: string | null, draftText: string) {
    if (!conversationId) return;
    setActiveId(conversationId);
    syncUrl(conversationId);
    const seq = ++loadSeq.current;
    try {
      const [detail, list] = await Promise.all([fetchConversation(conversationId), fetchConversations(mode)]);
      if (seq !== loadSeq.current) return;
      setMessages(detail.messages);
      setConversations(list);
      if (sendKey.reconcile(detail.messages, draftText)) {
        setDraft((current) => (current.trim() === draftText ? "" : current));
        setError(null);
        setStatus("This message was already sent.");
      }
    } catch (err) {
      if (seq === loadSeq.current && !redirectIfUnauthorized(err)) {
        setError({ message: "Could not load the conversation. Reload the page." });
      }
    }
  }

  // The sources the next message uses: the user's pick, or the source that the draft names.
  const picked = { webSearch, useGoogle, apps, ...(research ? { research: true as const } : {}) };
  const sources = autoOff ? picked : autoSources(draft, picked, google, connectedApps);

  async function submit(action: "send" | "retry") {
    if (sending) return;
    const text = draft.trim();
    if (action === "send" && (!text || text.length > MAX_MESSAGE_CHARS)) return;
    if (action === "retry" && !activeId) return;

    const lastSent = lastSentRef.current;
    const turnSources = action === "retry" && lastSent && lastSent.conversationId === activeId ? lastSent.sources : sources;
    if (action === "send") lastSentRef.current = { conversationId: activeId, sources };
    const sentApps = turnSources.apps;
    const connectors = sentApps.length > 0 ? { connectors: [...sentApps] } : {};
    const timeZone = browserTimeZone();
    const zone = timeZone ? { timeZone } : {};
    const body: ChatRequest =
      action === "send"
        ? {
            action,
            message: text,
            webSearch: sources.webSearch,
            ...(sources.research && sources.webSearch ? { research: true as const } : {}),
            effort,
            ...connectors,
            ...(sources.useGoogle ? { useGoogle: true as const } : {}),
            ...(activeId ? { conversationId: activeId } : { mode }),
            ...zone,
          }
        : {
            action,
            conversationId: activeId!,
            webSearch: turnSources.webSearch,
            ...(turnSources.research && turnSources.webSearch ? { research: true as const } : {}),
            effort,
            ...connectors,
            ...(turnSources.useGoogle ? { useGoogle: true as const } : {}),
            ...zone,
          };

    const keyHeaders = action === "send" ? sendKey.headers(activeId ? { conversationId: activeId } : { mode }, text) : {};
    const sentEffort = { effort, version: effortVersion.current };
    // The mode when the user pressed Send decides whether Auto may act on this reply.
    const sentInAuto = approvalMode === "auto";
    const controller = new AbortController();
    abortRef.current = controller;
    const tempId = `pending-${now()}`;
    let accepted = false;
    // The user message this turn answers: the retried one, or the new one once the server saved it.
    let turnUserId: string | null = action === "retry" ? ([...messages].reverse().find((m) => m.role === "user")?.id ?? null) : null;
    let finished = false;

    const restoreDraft = () => {
      if (action !== "send") return;
      setMessages((current) => current.filter((message) => message.id !== tempId));
      setDraft((current) => (current ? current : text));
    };

    const stoppedPartial = action === "send" ? stopped?.partial : undefined;
    setSending(true);
    setOpenMenu(null);
    stick.jump();
    setError(null);
    setStopped(null);
    setStalled(false);
    stalledRef.current = false;
    streamTextRef.current = "";
    lastEventRef.current = now();
    setStreaming({ text: "", search: null });
    setStatus("Sending…");
    if (action === "send") {
      // Stop dictating, so words heard after Send do not land in the next message.
      dictation.cancel();
      setDraft("");
      setUseGoogle(false);
      if (research) {
        setResearch(false);
        setWebSearch(false);
      }
      setAutoOff(false);
      starterToolsRef.current = false;
      setMessages((current) => [
        ...current,
        // A stopped reply stays on screen above the next message. It is not saved.
        ...(stoppedPartial
          ? [
              {
                id: `stopped-${tempId}`,
                role: "assistant" as const,
                content: stoppedPartial,
                webSearch: "off" as const,
                sources: [],
                route: null,
                createdAt: new Date().toISOString(),
                stopped: true,
              },
            ]
          : []),
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
      const stream = await postChat(body, controller.signal, keyHeaders);
      for await (const event of readChatStream(stream)) {
        lastEventRef.current = now();
        if (stalledRef.current) {
          stalledRef.current = false;
          setStalled(false);
          setStatus("P-Dot is replying…");
        }
        switch (event.type) {
          case "start":
            accepted = true;
            turnUserId = event.userMessage.id;
            if (action === "send") sendKey.saved();
            if (sentInAuto) setAutoTurns((turns) => new Set(turns).add(event.userMessage.id));
            // "Think harder" applies to one message, so a forgotten switch does not keep using the heavy tier.
            setEffort((current) => effortAfterAccept(sentEffort, { effort: current, version: effortVersion.current }));
            // One message only. An app the user turned on after Send stays on for the next message.
            if (sentApps.length > 0) setApps((current) => current.filter((app) => !sentApps.includes(app)));
            setActiveId(event.conversation.id);
            if (lastSentRef.current && lastSentRef.current.conversationId === null) lastSentRef.current.conversationId = event.conversation.id;
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
            setStatus(sentApps.length > 0 ? "Reading your apps…" : webSearch ? "Searching the web…" : "P-Dot is replying…");
            break;
          case "search":
            setStreaming((current) => ({
              text: current?.text ?? "",
              search: { status: event.status, sources: event.sources, message: event.message },
              tier: current?.tier,
            }));
            setStatus(event.status === "used" ? "Web search complete. P-Dot is replying…" : (event.message ?? ""));
            break;
          case "status": {
            const line = toolStatusLine(event.tool, event.query, event.count);
            setStreaming((current) => ({
              text: current?.text ?? "",
              search: current?.search ?? null,
              tier: current?.tier,
              tool: line,
            }));
            setStatus(line);
            break;
          }
          case "delta":
            streamTextRef.current += event.text;
            setStreaming((current) => ({
              text: (current?.text ?? "") + event.text,
              search: current?.search ?? null,
              tier: current?.tier,
            }));
            break;
          case "done":
            finished = true;
            // Web search is for one message, like "Think harder": a forgotten switch would spend credits.
            setWebSearch(false);
            setMessages((current) => [...current, { ...event.message, truncated: event.truncated }]);
            setStreaming(null);
            setSuggestionsKey((key) => key + 1);
            notifyActionsChanged();
            setStatus("Reply complete.");
            // The reply is saved. The stream can still bring a title; the next message need not wait for it.
            setSending(false);
            break;
          case "title":
            setConversations((list) => list.map((c) => (c.id === event.conversationId ? { ...c, title: event.title } : c)));
            break;
          case "error":
            finished = true;
            setStreaming(null);
            showTurnError(
              { ...chatErrorView(event.code, event.message, { retryable: event.retryable, trial }), partial: streamTextRef.current },
              turnUserId,
            );
            setStatus("");
            break;
        }
      }
      if (!finished) {
        setStreaming(null);
        setError({ message: "The reply did not finish. Try again.", retryable: true, partial: streamTextRef.current, turn: true });
      }
    } catch (err) {
      // After done the reply is saved and shown. A later problem (a lost title, Stop, a cut stream) is not an error.
      if (finished) return;
      setStreaming(null);
      if (isAbort(err)) {
        if (!accepted) restoreDraft();
        // Stop is not an error: the partial text stays, muted, and the user can retry or type again.
        if (leftStreamRef.current !== controller) {
          if (accepted) {
            setStopped({ partial: streamTextRef.current });
            // The prompt goes back in the box, so the user can change it and send again.
            if (action === "send") setDraft((current) => (current ? current : text));
          }
          setStatus("Reply stopped.");
          inputRef.current?.focus();
        }
      } else if (!redirectIfUnauthorized(err)) {
        if (!accepted) restoreDraft();
        const view =
          err instanceof ApiError
            ? chatErrorView(err.code, err.message, { trial })
            : { message: "P-Dot could not reply. Try again.", retryable: true, limit: false };
        showTurnError({ ...view, partial: accepted ? streamTextRef.current : "" }, turnUserId);
        setStatus("");
        if (!accepted && sendKey.refused(err, action) === "answered") {
          void showSavedMessage((err as ApiError).conversationId ?? activeId, action === "send" ? text : "");
        }
      }
    } finally {
      // An earlier send whose stream ends late (a title after done) must not free a newer send.
      if (abortRef.current === controller) {
        abortRef.current = null;
        setSending(false);
      }
    }
  }

  const googleItem = googleToolItem(google, sources.useGoogle);
  // The "+" menu: web search, Think harder, Google, then each connected app. A new tool is one more item.
  const tools: ToolItem[] = [
    {
      key: "web",
      title: "Search the web",
      description: messages.some((m) => m.route?.reason === "google_request" || m.route?.reason === "connector_read")
        ? "In this chat, only with your own words, because P-Dot read your Google or app data here."
        : "Current pages, with sources.",
      chip: "Web search",
      chipClass: "chip-web",
      icon: "web",
      on: webSearch && !research,
    },
    {
      key: "research",
      title: "Deep research",
      description: "Reads the top pages and writes a cited brief. Slower. This message only.",
      chip: "Deep research",
      chipClass: "chip-web",
      icon: "web",
      on: research,
    },
    {
      key: "deep",
      title: "Think harder",
      description: "Stronger model. Slower. This message only.",
      chip: "Think harder",
      chipClass: "chip-deep",
      icon: "deep",
      on: effort === "deep",
    },
    ...(googleItem ? [googleItem] : []),
    ...connectedApps.map(
      (app): ToolItem => ({
        key: `app:${app}`,
        title: `Use ${MCP_SERVER_NAMES[app]}`,
        description: "Read only, for this message.",
        chip: MCP_SERVER_NAMES[app],
        chipClass: "chip-app",
        icon: "app",
        on: sources.apps.includes(app),
      }),
    ),
  ];

  function toggleTool(key: string) {
    starterToolsRef.current = false;
    if (key === "deep") {
      effortVersion.current += 1;
      setEffort((current) => (current === "deep" ? "auto" : "deep"));
      return;
    }
    if (key === "google" && google !== "connected") return;
    const next = toggleSource(sources, key, connectedApps);
    setAutoOff(true);
    setWebSearch(next.webSearch);
    setResearch(next.research === true);
    setUseGoogle(next.useGoogle);
    setApps(next.apps);
  }

  function pickStarter(prompt: StarterPrompt) {
    setDraft(prompt.text);
    setWebSearch(prompt.webSearch);
    setResearch(false);
    if (prompt.webSearch) {
      setUseGoogle(false);
      setApps([]);
    }
    effortVersion.current += 1;
    setEffort(prompt.effort);
    starterToolsRef.current = prompt.webSearch || prompt.effort !== "auto";
    inputRef.current?.focus();
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
    pins.unpin(id);
    if (activeId === id) startNewConversation();
    setConfirmDeleteId(null);
    setDeletingId(null);
    setStatus("Conversation deleted.");
  }

  // A stopped reply on this screen only is not a reply to the message before it.
  const last = [...messages].reverse().find((m) => !m.stopped);
  // A message whose last error said Retry cannot help keeps no Retry, also after Dismiss.
  const canRetry = canRetryLast({ sending, loadingMessages, activeId, last, noRetryIds });
  const activeTitle = conversations.find((c) => c.id === activeId)?.title;
  const limit = composerLimit(draft.length);

  // Oldest first, so a reply's suggestions read in the order P-Dot made them.
  const conversationProposals = activeId
    ? actions.proposals
        .filter((p) => p.conversationId === activeId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    : [];
  // In Auto, safe actions from replies to messages sent in Auto are approved through the normal decision route.
  const auto = useAutoApprovals({
    mode: approvalMode,
    messages,
    proposals: conversationProposals,
    autoTurns,
    onDecided: actions.decided,
    onStale: actions.stale,
    onUnauthorized: goToLogin,
  });
  const autoRunning = new Set(auto.running.map((p) => p.id));
  const placedProposals = placeByTime(messages, conversationProposals);
  const placedSuggestions = placeBySource(messages, memorySuggestions.items);
  const hasOpenCard = conversationProposals.some((p) => p.status === "proposed" && !autoRunning.has(p.id));
  // "Waiting for you" on a reply with a card to decide; "Done" on the last reply otherwise.
  const turnStates = new Map<string, TurnState>();
  const lastReply = [...messages].reverse().find((m) => m.role === "assistant");
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const openAction = placedProposals.byMessage.get(message.id)?.some((p) => p.status === "proposed" && !autoRunning.has(p.id));
    const openMemory = placedSuggestions.get(message.id)?.some((s) => s.outcome === "waiting");
    if (openAction || openMemory) turnStates.set(message.id, "waiting");
    else if (message.id === lastReply?.id && !sending) turnStates.set(message.id, "done");
  }
  const showSuggestions = activeId !== null && !loadingMessages;
  const suggestionsFor = (proposals?: ActionProposalDTO[], suggestions?: MemorySuggestion[]) =>
    showSuggestions && (
      <TurnExtras
        proposals={proposals}
        suggestions={suggestions}
        approvalMode={approvalMode}
        autoRunning={autoRunning}
        autoRan={auto.ran}
        askReasons={auto.asks}
        decidedHere={actions.decidedHere}
        onDecided={actions.decided}
        onStale={actions.stale}
        onKept={memorySuggestions.kept}
        onDropped={memorySuggestions.dropped}
        onUnauthorized={goToLogin}
      />
    );

  return (
    <div className={`chat-layout${sidebarCollapsed ? " is-collapsed" : ""}`}>
      {showList && <div ref={drawerBackdropRef} className="drawer-backdrop" aria-hidden="true" onClick={closeList} />}
      <aside
        ref={drawerRef}
        id="chat-drawer"
        className={`chat-sidebar${showList ? " is-open" : ""}`}
        aria-label="Conversations"
        role={showList ? "dialog" : undefined}
        aria-modal={showList ? true : undefined}
      >
        <div className="drawer-head">
          <p className="drawer-title">Conversations</p>
          <button
            ref={drawerCloseRef}
            type="button"
            className="icon-button drawer-close"
            aria-label="Close conversations"
            onClick={closeList}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
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
          {orderByPins(conversations, pins.pins).map((conversation) => (
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
                    className={`icon-button pin-button${pins.pins.includes(conversation.id) ? " is-pinned" : ""}`}
                    onClick={() => pins.toggle(conversation.id)}
                    aria-pressed={pins.pins.includes(conversation.id)}
                    aria-label={`Pin “${conversation.title}”`}
                    title={pins.pins.includes(conversation.id) ? "Unpin conversation" : "Pin conversation to the top"}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill={pins.pins.includes(conversation.id) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M9 4h6l-1 6 4 4H6l4-4-1-6zM12 14v6" />
                    </svg>
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
            className="icon-button desktop-only"
            aria-expanded={!sidebarCollapsed}
            aria-controls="chat-drawer"
            aria-label={sidebarCollapsed ? "Show conversations" : "Hide conversations"}
            title={sidebarCollapsed ? "Show conversations" : "Hide conversations"}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
            </svg>
          </button>
          <button
            ref={drawerToggleRef}
            type="button"
            className="button button-small mobile-only"
            aria-expanded={showList}
            aria-controls="chat-drawer"
            onClick={() => setShowList((open) => !open)}
          >
            Conversations
          </button>
          <h1 className="chat-title">{activeTitle ?? (activeId ? "Conversation" : "New conversation")}</h1>
        </div>

        <div className="message-list" ref={listRef}>
          {loadingMessages && <p className="muted">Loading conversation…</p>}
          {!loadingMessages && messages.length === 0 && !streaming && (
            <div className="empty-state">
              <p>{EMPTY_TITLES[mode]}</p>
              <p className="muted small">P-Dot asks before it adds a task, a reminder or a memory. You can say no.</p>
              <StarterPrompts mode={mode} onPick={pickStarter} />
              <p className="disclaimer">P-Dot can make mistakes. Check important facts.</p>
            </div>
          )}
          {messages.map((message) => (
            <Fragment key={message.id}>
              <MessageItem message={message} state={turnStates.get(message.id)} />
              {suggestionsFor(placedProposals.byMessage.get(message.id), placedSuggestions.get(message.id))}
            </Fragment>
          ))}
          {streaming && (
            <article className="message message-assistant" aria-busy="true">
              <p className="message-author">P-Dot</p>
              <p className="turn-state" data-state={stalled ? "stalled" : "working"}>
                {stalled
                  ? STALL_LINE
                  : turnStepLine({
                      text: streaming.text,
                      tool: streaming.tool,
                      searching: webSearch && !streaming.search,
                      deep: research,
                      tier: streaming.tier,
                    })}
              </p>
              {streaming.search && <SearchNotice status={streaming.search.status} message={streaming.search.message} />}
              {streaming.text && (
                <AssistantReply
                  text={streaming.text}
                  sources={streaming.search?.sources ?? []}
                  messageId="live"
                  showSources={streaming.search?.status === "used"}
                  streaming
                />
              )}
            </article>
          )}
          {(stopped || error?.partial) && (
            <article className="message message-assistant message-partial">
              <p className="turn-state" data-state={stopped ? "stopped" : "failed"}>
                {stopped ? "You stopped this reply. It is not saved." : "This reply stopped. It is not saved."}
              </p>
              {(stopped?.partial || error?.partial) && <Markdown text={(stopped?.partial || error?.partial)!} />}
            </article>
          )}
          {error ? (
            <div className="turn-error" role="alert">
              <p>{error.message}</p>
              <div className="actions">
                {trial && error.limit && (
                  <Link className="button button-small button-primary" href="/signup">
                    Create an account
                  </Link>
                )}
                {error.turn && error.retryable && canRetry && (
                  <button type="button" className="button button-small" onClick={() => void submit("retry")}>
                    Retry
                  </button>
                )}
                <button type="button" className="button button-small" onClick={() => setError(null)}>
                  Dismiss
                </button>
              </div>
            </div>
          ) : (
            canRetry && (
              <div className="turn-retry">
                <p className="small muted">{stopped ? "You can send a new message, or retry." : "This message has no reply yet."}</p>
                <button type="button" className="button button-small" onClick={() => void submit("retry")}>
                  Retry
                </button>
              </div>
            )
          )}
          {suggestionsFor(placedProposals.rest)}
          {stick.showJump && (
            <button type="button" className="jump-latest" onClick={stick.jump}>
              Jump to latest
            </button>
          )}
        </div>

        {/* Once per device, and only when the first card waits: choose Ask first or Auto. Outside the form, so Enter cannot send. */}
        {hasOpenCard && <ApprovalModeSetup onChoose={() => setOpenMenu("approval")} />}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit("send");
          }}
        >
          <div className="composer-box">
            <ToolChips items={tools} onToggle={toggleTool} disabled={sending} inputRef={inputRef} />
            <label htmlFor="composer-input" className="visually-hidden">
              Message
            </label>
            <textarea
              id="composer-input"
              ref={inputRef}
              value={draft}
              onChange={(event) => {
                const value = event.target.value;
                setDraft(value);
                if (!value.trim()) setAutoOff(false);
                if (!value.trim() && starterToolsRef.current) {
                  starterToolsRef.current = false;
                  setWebSearch(false);
                  effortVersion.current += 1;
                  setEffort("auto");
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (!sending) void submit("send");
                } else if (event.key === "Escape" && dictation.listening) {
                  dictation.toggle();
                }
              }}
              rows={2}
              placeholder={sending ? "Press Stop to send a new message" : "Ask P-Dot anything"}
              aria-describedby={limit.over ? "composer-hint composer-limit" : "composer-hint"}
              aria-invalid={limit.over ? true : undefined}
            />
            {limit.message && (
              <p id="composer-limit" className="alert alert-warning small composer-limit" role="status">
                {limit.message}
              </p>
            )}
            {dictation.listening && (
              <p className="dictation-live">
                <span role="status">Listening… speak now. Tap the microphone or press Esc to stop.</span>
                {/* Not announced: it changes with every word. The settled words go into the message box. */}
                {dictation.interim && <span className="dictation-interim">“{dictation.interim}”</span>}
              </p>
            )}
            <div className="composer-bar">
              <ToolsMenu
                open={openMenu === "tools"}
                onOpenChange={(open) => setOpenMenu(open ? "tools" : null)}
                items={tools}
                onToggle={toggleTool}
                disabled={sending}
              />
              <ApprovalModeMenu
                open={openMenu === "approval"}
                onOpenChange={(open) => setOpenMenu(open ? "approval" : null)}
                disabled={sending}
              />
              <span id="composer-hint" className="visually-hidden">
                Enter to send. Shift and Enter for a new line.
              </span>
              {limit.showCount && (
                <span className={`hint composer-count${limit.over ? " is-over" : ""}`}>
                  {draft.length} / {MAX_MESSAGE_CHARS}
                </span>
              )}
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
              {/* One element for Send and Stop, so focus stays on it when the label changes. */}
              <button
                type={sending ? "button" : "submit"}
                className={`round-button ${sending ? "round-button-stop" : "round-button-solid"}`}
                aria-label={sending ? "Stop reply" : "Send message"}
                title={sending ? "Stop reply" : "Send (Enter)"}
                aria-disabled={!sending && (!draft.trim() || limit.over) ? true : undefined}
                onClick={(event) => {
                  if (sending) {
                    // Stop puts the prompt back and turns this into Send before the click ends, so the click must not submit it.
                    event.preventDefault();
                    abortRef.current?.abort();
                  } else if (!draft.trim() || limit.over) {
                    event.preventDefault();
                  }
                }}
              >
                {sending ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          {dictation.error && (
            <p className="alert alert-warning small" role="alert">
              {dictation.error}
            </p>
          )}
        </form>

        <p className="visually-hidden" role="status" aria-live="polite">
          {status}
        </p>
      </main>
    </div>
  );
}
