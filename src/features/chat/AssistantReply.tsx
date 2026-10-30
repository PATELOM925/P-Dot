"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SourceRef } from "@/types/api";
import { CiteContext } from "./markdown/cite";
import { Markdown } from "./markdown/Markdown";
import { parseMarkdown } from "./markdown/parse";
import { planReply } from "./markdown/plan";
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
  const sourceCount = showSources ? sources.length : 0;
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  // One plan for the text and the sources row: a citation inside a card counts as cited too.
  const plan = useMemo(() => planReply(blocks, sourceCount, streaming), [blocks, sourceCount, streaming]);

  return (
    <CiteContext.Provider value={context}>
      <Markdown text={text} streaming={streaming} blocks={blocks} plan={plan} />
      {showSources && (
        <SourceRow
          sources={sources}
          cited={plan.cited}
          messageId={messageId}
          open={open}
          onToggle={() => setOpen((value) => !value)}
          highlight={highlight}
        />
      )}
    </CiteContext.Provider>
  );
}
