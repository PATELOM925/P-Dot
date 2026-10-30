"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { toSafeHttpUrl } from "@/lib/safe-url";
import { parseMarkdown, type Block, type Inline } from "./parse";

// Every node becomes a React element or text. No HTML string is ever inserted.

function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  const url = toSafeHttpUrl(href);
  if (!url) return <>{children}</>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow">
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
        // Images from model output never load. The alt text stands in, as a link when the URL is safe.
        return (
          <SafeLink key={index} href={node.href}>
            {node.alt || "Image"}
          </SafeLink>
        );
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

function renderBlocks(blocks: Block[]): ReactNode[] {
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
        return <CodeBlock key={index} lang={block.lang} text={block.text} />;
      case "quote":
        return <blockquote key={index}>{renderBlocks(block.children)}</blockquote>;
      case "rule":
        return <hr key={index} />;
      case "list": {
        const items = block.items.map((item, itemIndex) => (
          <li key={itemIndex}>
            {item.task && <span aria-hidden="true">{item.task === "done" ? "☑ " : "☐ "}</span>}
            {item.task && <span className="visually-hidden">{item.task === "done" ? "Done: " : "Not done: "}</span>}
            {renderInline(item.content)}
            {item.children.length > 0 && renderBlocks(item.children)}
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
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="message-content md">{renderBlocks(blocks)}</div>;
}
