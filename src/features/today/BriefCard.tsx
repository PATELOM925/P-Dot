"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AssistantReply } from "@/features/chat/AssistantReply";
import { ApiError, postChat } from "@/features/chat/api";
import { readChatStream } from "@/features/chat/stream";
import { toolStatusLine } from "@/features/chat/tool-status";
import { BRIEF_MAX_TOPICS } from "@/lib/limits";
import type { Mode, SourceRef } from "@/types/api";
import { briefRequest, briefTopicsKey, localBriefDate, parseTopics, topicsFromMemories } from "./brief";

type BriefState =
  | { phase: "idle" }
  | { phase: "running"; status: string; text: string; sources: SourceRef[]; conversationId: string | null }
  | { phase: "done"; text: string; sources: SourceRef[]; conversationId: string; messageId: string }
  | { phase: "error"; message: string; conversationId: string | null };

const noSubscription = () => () => {};

function readStoredTopics(mode: Mode): string | null {
  try {
    return window.localStorage.getItem(briefTopicsKey(mode));
  } catch {
    return null;
  }
}

/**
 * The morning brief (decision 0018). Only a click on "Make today's brief"
 * starts it. It is a chat turn: the server saves it as a new conversation, so
 * it can be opened again with "What was sent".
 */
export function BriefCard({ mode, memoryTopics }: { mode: Mode; memoryTopics: string[] }) {
  // Null until the user types: then the stored topics, or topics from memories, show.
  const [edited, setEdited] = useState<string | null>(null);
  const stored = useSyncExternalStore(noSubscription, () => readStoredTopics(mode), () => null);
  const topicsText = edited ?? stored ?? topicsFromMemories(memoryTopics);
  const [state, setState] = useState<BriefState>({ phase: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const topics = parseTopics(topicsText);
  const running = state.phase === "running";

  function saveTopics(value: string) {
    setEdited(value);
    try {
      window.localStorage.setItem(briefTopicsKey(mode), value);
    } catch {
      // Private mode or full storage: the topics last for this page only.
    }
  }

  async function makeBrief() {
    if (running || topics.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    let conversationId: string | null = null;
    let text = "";
    let sources: SourceRef[] = [];
    setState({ phase: "running", status: "Starting the brief…", text, sources, conversationId });
    try {
      const stream = await postChat(briefRequest(mode, topics, localBriefDate(new Date())), controller.signal);
      for await (const event of readChatStream(stream)) {
        if (event.type === "start") {
          conversationId = event.conversation.id;
          setState({ phase: "running", status: "Searching today's news…", text, sources, conversationId });
        } else if (event.type === "status") {
          setState({ phase: "running", status: toolStatusLine(event.tool, event.query, event.count), text, sources, conversationId });
        } else if (event.type === "search") {
          sources = event.sources;
          const status = event.status === "used" ? "Writing the brief…" : (event.message ?? "No news was found.");
          setState({ phase: "running", status, text, sources, conversationId });
        } else if (event.type === "delta") {
          text += event.text;
          setState({ phase: "running", status: "Writing the brief…", text, sources, conversationId });
        } else if (event.type === "done") {
          setState({
            phase: "done",
            text: event.message.content,
            sources: event.message.sources,
            conversationId: conversationId ?? "",
            messageId: event.message.id,
          });
          return;
        } else if (event.type === "error") {
          setState({ phase: "error", message: event.message, conversationId });
          return;
        }
      }
      setState({ phase: "error", message: "The brief stopped before it was complete. Try again.", conversationId });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message =
        error instanceof ApiError && error.status === 401
          ? "Sign in again to make a brief."
          : error instanceof Error
            ? error.message
            : "Could not make the brief. Try again.";
      setState({ phase: "error", message, conversationId });
    }
  }

  return (
    <section className="panel brief-card" aria-labelledby="brief-heading" aria-busy={running}>
      <div className="panel-heading">
        <h2 id="brief-heading">Morning brief</h2>
        <span className="muted small">Today&apos;s news on your topics</span>
      </div>

      <form
        className="task-form brief-form"
        onSubmit={(event) => {
          event.preventDefault();
          void makeBrief();
        }}
      >
        <label htmlFor="brief-topics" className="visually-hidden">
          Topics
        </label>
        <input
          id="brief-topics"
          type="text"
          value={topicsText}
          maxLength={200}
          placeholder="Topics, for example: cricket, local news, AI"
          disabled={running}
          onChange={(event) => saveTopics(event.target.value)}
        />
        <button type="submit" className="button button-primary" disabled={running || topics.length === 0}>
          {running ? "Making…" : "Make today's brief"}
        </button>
      </form>
      <p className="hint">
        Up to {BRIEF_MAX_TOPICS} topics, with commas between them. P-Dot sends each topic to its web search provider, then
        saves the brief as a conversation.
      </p>

      {state.phase === "running" && (
        <>
          <p className="hint tool-status" role="status">
            {state.status}
          </p>
          {state.text && (
            <AssistantReply text={state.text} sources={state.sources} messageId="brief-live" showSources={state.sources.length > 0} streaming />
          )}
        </>
      )}

      {state.phase === "done" && (
        <>
          <AssistantReply text={state.text} sources={state.sources} messageId={state.messageId} showSources={state.sources.length > 0} />
          <Link className="button" href={`/chat?c=${encodeURIComponent(state.conversationId)}`}>
            Open in chat
          </Link>
        </>
      )}

      {state.phase === "error" && (
        <p className="alert alert-error small" role="alert">
          {state.message}
          {state.conversationId && (
            <>
              {" "}
              <Link href={`/chat?c=${encodeURIComponent(state.conversationId)}`}>Open the conversation</Link>
            </>
          )}
        </p>
      )}
    </section>
  );
}
