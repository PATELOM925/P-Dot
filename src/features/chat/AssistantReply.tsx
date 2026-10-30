"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SourceRef } from "@/types/api";
import { CiteContext, citedNumbers } from "./markdown/cite";
import { Markdown } from "./markdown/Markdown";
import { SourceRow } from "./SourceRow";

const HIGHLIGHT_MS = 1200;

/**
 * One reply: its Markdown with citation chips, and its sources row. The same
 * component renders the live reply and the saved one, so nothing jumps at the end.
 */
export function AssistantReply({
  text,
  sources,
  messageId,
  showSources,
  streaming = false,
}: {
  text: string;
  sources: SourceRef[];
  messageId: string;
  showSources: boolean;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onCite = useCallback(
    (n: number) => {
      setOpen(true);
      setHighlight(n);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
      window.requestAnimationFrame(() => document.getElementById(`src-${messageId}-${n}`)?.scrollIntoView({ block: "nearest" }));
    },
    [messageId],
  );
  const context = useMemo(() => ({ sources: showSources ? sources : [], messageId, onCite }), [sources, showSources, messageId, onCite]);
  const cited = useMemo(() => citedNumbers(text, showSources ? sources.length : 0), [text, sources.length, showSources]);

  return (
    <CiteContext.Provider value={context}>
      <Markdown text={text} streaming={streaming} />
      {showSources && (
        <SourceRow
          sources={sources}
          cited={cited}
          messageId={messageId}
          open={open}
          onToggle={() => setOpen((value) => !value)}
          highlight={highlight}
        />
      )}
    </CiteContext.Provider>
  );
}
