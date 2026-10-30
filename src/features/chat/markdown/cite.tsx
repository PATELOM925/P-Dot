"use client";

import { createContext, useContext, useId } from "react";
import type { SourceRef } from "@/types/api";

export interface CiteContextValue {
  sources: SourceRef[];
  messageId: string;
  /** Opens the reply's source list and marks source n. */
  onCite: (n: number) => void;
}

export const CiteContext = createContext<CiteContextValue | null>(null);

/** The host of a URL without "www.", or "" for a bad URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * "[n]" as a small number chip. Hover or focus shows the host and title. A click
 * opens the source list at source n; it never opens the outside page itself.
 * A number with no matching source stays muted text.
 */
export function CiteChip({ n }: { n: number }) {
  const context = useContext(CiteContext);
  const tipId = useId();
  const source = context && n >= 1 && n <= context.sources.length ? context.sources[n - 1] : undefined;
  if (!context || !source) {
    return (
      <span className="cite-missing" title={`P-Dot has no source ${n} for this reply.`}>
        [{n}]
      </span>
    );
  }
  const host = hostOf(source.url);
  return (
    <a
      className="cite"
      href={`#src-${context.messageId}-${n}`}
      aria-label={`Source ${n}${host ? `, ${host}` : ""}`}
      aria-describedby={tipId}
      onClick={(event) => {
        event.preventDefault();
        context.onCite(n);
      }}
    >
      {n}
      <span id={tipId} role="tooltip" className="cite-tip">
        {host && <span className="cite-tip-host">{host}</span>}
        <span className="cite-tip-title">{source.title}</span>
      </span>
    </a>
  );
}
