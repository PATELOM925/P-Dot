"use client";

import { useId } from "react";
import { toSafeHttpUrl } from "@/lib/safe-url";
import type { SourceRef } from "@/types/api";
import { hostOf } from "./markdown/cite";

/**
 * The sources of one reply as one quiet line: "5 sources · 3 cited · a.com, b.com, +3".
 * Open, it lists them by number, cited first. A source keeps its number when its
 * link is removed, so each [n] chip still points to the right line.
 */
export function SourceRow({
  sources,
  cited,
  messageId,
  open,
  onToggle,
  highlight,
}: {
  sources: SourceRef[];
  cited: ReadonlySet<number>;
  messageId: string;
  open: boolean;
  onToggle: () => void;
  highlight: number | null;
}) {
  const listId = useId();
  if (sources.length === 0) return null;

  const entries = sources.map((source, index) => {
    const url = toSafeHttpUrl(source.url);
    return { n: index + 1, title: source.title, url, host: url ? hostOf(url) : "" };
  });
  const hosts = [...new Set(entries.map((entry) => entry.host).filter(Boolean))];
  const shownHosts = hosts.slice(0, 2).join(", ") + (hosts.length > 2 ? `, +${hosts.length - 2}` : "");
  const citedPart = cited.size > 0 ? ` · ${cited.size} cited` : " · none cited";
  const ordered = [...entries.filter((e) => cited.has(e.n)), ...entries.filter((e) => !cited.has(e.n))];

  return (
    <div className="sources-row">
      <button type="button" className="sources-toggle" aria-expanded={open} aria-controls={listId} onClick={onToggle}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> {sources.length} {sources.length === 1 ? "source" : "sources"}
        {citedPart}
        {!open && shownHosts && ` · ${shownHosts}`}
      </button>
      <div id={listId} hidden={!open}>
        <p className="sources-context">P-Dot used these pages as context. They do not prove the answer.</p>
        <ol className="sources-list">
          {ordered.map((entry) => (
            <li
              key={entry.n}
              id={`src-${messageId}-${entry.n}`}
              className={highlight === entry.n ? "is-highlighted" : undefined}
            >
              <span className="sources-n">{entry.n}</span>
              {entry.url ? (
                <a href={entry.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" title={entry.title}>
                  <span className="sources-title-text">{entry.title}</span>
                  <span className="sources-host">{entry.host} ↗</span>
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              ) : (
                <span>
                  <span className="sources-title-text">{entry.title}</span> <span className="sources-host">Link removed</span>
                </span>
              )}
              {!cited.has(entry.n) && <span className="sources-not-cited">not cited</span>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
