"use client";

import { useEffect, useId, useRef, useState } from "react";
import { LocalTime } from "@/components/ui/LocalTime";
import { ApiError, errorMessage } from "@/lib/api-client";
import { modelDisplayName } from "@/lib/routing";
import type { ContextRecordDTO } from "@/types/api";
import { fetchContextRecord } from "./api";

type LoadState =
  | { status: "idle" | "loading" }
  /** `recent`: the reply is new, so its record may still be on its way. */
  | { status: "missing"; recent: boolean }
  | { status: "ready"; record: ContextRecordDTO }
  | { status: "error"; message: string };

/** The server saves a reply's record just after it sends the reply, so a new reply can be briefly without one. */
const RECORD_GRACE_MS = 60_000;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/**
 * "What was sent" for one assistant reply: which model answered and what
 * context it received. Loaded only when opened. P-Dot stores counts and IDs
 * for this, not a second copy of the text.
 */
export function WhatWasSent({ messageId, createdAt }: { messageId: string; createdAt: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<LoadState>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  function fetchRecord() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setLoad({ status: "loading" });
    fetchContextRecord(messageId, current.signal).then(
      (record) => setLoad({ status: "ready", record }),
      (err: unknown) => {
        if (current.signal.aborted) return;
        if (err instanceof ApiError && err.status === 404) {
          setLoad({ status: "missing", recent: Date.now() - Date.parse(createdAt) < RECORD_GRACE_MS });
        } else {
          setLoad({ status: "error", message: errorMessage(err, "Could not load what was sent.") });
        }
      },
    );
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    // A record never changes once saved, so a loaded one is kept. A missing one is asked for again.
    if (next && load.status !== "loading" && load.status !== "ready") fetchRecord();
  }

  return (
    <div className="sent">
      <button type="button" className="link-button sent-toggle" aria-expanded={open} aria-controls={id} onClick={toggle}>
        {open ? "Hide what was sent" : "What was sent"}
      </button>
      {open && (
        <div id={id} className="sent-details" role="region" aria-label="What was sent to the model for this reply">
          {load.status === "loading" && <p className="muted small">Loading…</p>}
          {load.status === "missing" && load.recent && (
            <p className="muted small">
              P-Dot saves this record just after the reply, so it may not be ready yet.{" "}
              <button type="button" className="link-button" onClick={fetchRecord}>
                Check again
              </button>
            </p>
          )}
          {load.status === "missing" && !load.recent && (
            <p className="muted small">
              No record for this reply. Replies from before P-Dot started recording what it sends, and replies whose
              record could not be saved, have none.
            </p>
          )}
          {load.status === "error" && (
            <p className="alert alert-error small" role="alert">
              {load.message}{" "}
              <button type="button" className="link-button" onClick={fetchRecord}>
                Retry
              </button>
            </p>
          )}
          {load.status === "ready" && <RecordDetails record={load.record} />}
        </div>
      )}
    </div>
  );
}

function RecordDetails({ record }: { record: ContextRecordDTO }) {
  const deletedMemories = record.memories.filter((m) => m.content === null).length;
  const keptMemories = record.memories.filter((m) => m.content !== null);
  const documents = [...new Set(record.documentChunks.map((c) => c.title ?? "A document you have since deleted"))];

  return (
    <>
      <dl className="sent-list">
        <div>
          <dt>Model</dt>
          <dd>
            {modelDisplayName(record.model)} <span className="hint">({record.model}, on Nebius)</span>
          </dd>
        </div>
        <div>
          <dt>This conversation</dt>
          <dd>
            {plural(record.historyMessageCount, "message")}, {plural(record.historyChars, "character")}
          </dd>
        </div>
        <div>
          <dt>Memories</dt>
          <dd>
            {record.memories.length === 0 ? (
              "None"
            ) : (
              <ul className="plain-list">
                {keptMemories.map((m) => (
                  <li key={m.id}>{m.content}</li>
                ))}
                {deletedMemories > 0 && <li className="muted">{plural(deletedMemories, "memory", "memories")} you have since deleted</li>}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt>Documents</dt>
          <dd>
            {documents.length === 0 ? (
              "None"
            ) : (
              <ul className="plain-list">
                {documents.map((title) => (
                  <li key={title}>{title}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt>Web search</dt>
          <dd>{record.webSourceCount === 0 ? "Not used" : `${plural(record.webSourceCount, "excerpt")} from Tavily`}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>
            {record.inputTokens === null || record.outputTokens === null
              ? "Not reported by the provider"
              : `${record.inputTokens.toLocaleString()} in · ${record.outputTokens.toLocaleString()} out`}
          </dd>
        </div>
        <div>
          <dt>Instructions</dt>
          <dd>P-Dot&apos;s system prompt, version {record.promptVersion}</dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd>
            <LocalTime iso={record.createdAt} />
          </dd>
        </div>
      </dl>
      <p className="hint">
        Everything above went to Nebius to write this reply. P-Dot keeps these counts and IDs, not a second copy of your
        text. Memories and documents show their current text; deleting one removes it here too.
      </p>
    </>
  );
}
