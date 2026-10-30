"use client";

import { Component, Fragment, useContext, useMemo, useState, type ReactNode } from "react";
import type { RichBlockKind } from "@/lib/rich-blocks";
import { toSafeHttpUrl } from "@/lib/safe-url";
import { RichBlockView } from "../rich/RichBlocks";
import { CiteChip, CiteContext } from "./cite";
import { parseMarkdown, type Block, type Inline } from "./parse";
import { planReply, type ReplyPlan } from "./plan";

// Every node becomes a React element or text. No HTML string is ever inserted.

function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  const url = toSafeHttpUrl(href);
  if (!url) return <>{children}</>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" title={url}>
      {children}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>;
      case "break":
        return <br key={index} />;
      case "strong":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "del":
        return <s key={index}>{renderInline(node.children)}</s>;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "link":
        return (
          <SafeLink key={index} href={node.href}>
            {renderInline(node.children)}
          </SafeLink>
        );
      case "image":
        // Images from model output never load: a remote image would tell its server that the user read the reply.
        return (
          <span key={index} className="md-image-off">
            Image not shown: {node.alt.slice(0, 80) || "no description"}
          </span>
        );
      case "cite":
        return <CiteChip key={index} n={node.n} />;
    }
  });
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{lang}</span>
        <button
          type="button"
          className="md-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

interface RenderState {
  plan: ReplyPlan;
}

const RICH_LABELS: Record<RichBlockKind, string> = {
  places: "places",
  table: "table",
  checklist: "checklist",
  steps: "steps",
};

function CardFallback({ lang, text }: { lang: string; text: string }) {
  return (
    <div>
      <p className="hint rich-failed">P-Dot could not show this as a card.</p>
      <CodeBlock lang={lang} text={text} />
    </div>
  );
}

/** One card that fails while it renders shows its code, and the rest of the reply still shows. */
export class CardBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function renderCode(block: Extract<Block, { type: "code" }>, key: number, state: RenderState): ReactNode {
  const card = state.plan.cards.get(block);
  if (!card) return <CodeBlock key={key} lang={block.lang} text={block.text} />;
  // The JSON of a block never shows while it streams, only a placeholder of the card.
  if (card.kind === "pending") {
    return (
      <div key={key} className="rich-card rich-pending" aria-hidden="true">
        Preparing {RICH_LABELS[card.label]}…
      </div>
    );
  }
  const fallback = <CardFallback lang={block.lang} text={block.text} />;
  if (card.kind === "failed") return <Fragment key={key}>{fallback}</Fragment>;
  return (
    <CardBoundary key={key} fallback={fallback}>
      <RichBlockView block={card.block} />
    </CardBoundary>
  );
}

function renderBlocks(blocks: Block[], state: RenderState): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "paragraph":
        return <p key={index}>{renderInline(block.content)}</p>;
      case "heading":
        // Styled text with a heading role, never a real h1 or h2, so the page outline stays correct.
        return (
          <p key={index} className={`md-h md-h${Math.min(block.level, 3)}`} role="heading" aria-level={Math.max(3, Math.min(block.level + 2, 6))}>
            {renderInline(block.content)}
          </p>
        );
      case "code":
        return renderCode(block, index, state);
      case "quote":
        return <blockquote key={index}>{renderBlocks(block.children, state)}</blockquote>;
      case "rule":
        return <hr key={index} />;
      case "list": {
        const items = block.items.map((item, itemIndex) => (
          <li key={itemIndex}>
            {item.task && <span aria-hidden="true">{item.task === "done" ? "☑ " : "☐ "}</span>}
            {item.task && <span className="visually-hidden">{item.task === "done" ? "Done: " : "Not done: "}</span>}
            {renderInline(item.content)}
            {item.children.length > 0 && renderBlocks(item.children, state)}
          </li>
        ));
        return block.ordered ? (
          <ol key={index} start={block.start === 1 ? undefined : block.start}>
            {items}
          </ol>
        ) : (
          <ul key={index}>{items}</ul>
        );
      }
      case "table":
        return (
          <div key={index} className="md-table" role="region" aria-label="Table" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, cellIndex) => (
                    <th key={cellIndex} className={block.align[cellIndex] ? `md-align-${block.align[cellIndex]}` : undefined}>
                      {renderInline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className={block.align[cellIndex] ? `md-align-${block.align[cellIndex]}` : undefined}>
                        {renderInline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** An assistant reply as safe Markdown. Used for saved replies and for the text that streams in. */
/**
 * An assistant reply as safe Markdown. Used for saved replies and for the text that streams in.
 * `blocks` and `plan` come from `AssistantReply`, so the sources row counts the same citations.
 */
export function Markdown({
  text,
  streaming = false,
  blocks: givenBlocks,
  plan: givenPlan,
}: {
  text: string;
  streaming?: boolean;
  blocks?: Block[];
  plan?: ReplyPlan;
}) {
  const sourceCount = useContext(CiteContext)?.sources.length ?? 0;
  const blocks = useMemo(() => givenBlocks ?? parseMarkdown(text), [givenBlocks, text]);
  const plan = useMemo(() => givenPlan ?? planReply(blocks, sourceCount, streaming), [givenPlan, blocks, sourceCount, streaming]);
  return <div className="message-content md">{renderBlocks(blocks, { plan })}</div>;
}
