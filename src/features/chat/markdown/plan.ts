import { MAX_RICH_BLOCKS_PER_REPLY, parseRichBlock, richBlockKind, type RichBlock, type RichBlockKind } from "@/lib/rich-blocks";
import type { Block, Inline } from "./parse";

export type CardPlan = { kind: "card"; block: RichBlock } | { kind: "pending"; label: RichBlockKind } | { kind: "failed" };

export interface ReplyPlan {
  /** What each `pdot-*` code block shows: a card, a placeholder while it streams, or the code. */
  cards: Map<Block, CardPlan>;
  /** The source numbers that the reply cites, in its text and in the cards it shows. */
  cited: Set<number>;
}

/**
 * Walks a parsed reply in reading order, as the renderer does: it decides which
 * blocks show as cards (at most 3) and collects the citations that point to a
 * real source. The renderer and the sources row use the same plan.
 */
export function planReply(blocks: Block[], sourceCount: number, streaming: boolean): ReplyPlan {
  const cards = new Map<Block, CardPlan>();
  const cited = new Set<number>();
  let shown = 0;

  const cite = (n: number) => {
    if (n >= 1 && n <= sourceCount) cited.add(n);
  };
  const walkInline = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.type === "cite") cite(node.n);
      else if (node.type === "strong" || node.type === "em" || node.type === "del" || node.type === "link") walkInline(node.children);
    }
  };
  const citeCard = (card: RichBlock) => {
    const lists =
      card.kind === "places" ? card.data.items : card.kind === "steps" ? card.data.items : card.kind === "table" ? card.data.rows : [];
    for (const entry of lists) for (const n of entry.cite ?? []) cite(n);
  };
  const walk = (list: Block[]) => {
    for (const block of list) {
      switch (block.type) {
        case "paragraph":
        case "heading":
          walkInline(block.content);
          break;
        case "quote":
          walk(block.children);
          break;
        case "list":
          for (const item of block.items) {
            walkInline(item.content);
            walk(item.children);
          }
          break;
        case "table":
          for (const cell of block.head) walkInline(cell);
          for (const row of block.rows) for (const cell of row) walkInline(cell);
          break;
        case "code": {
          const kind = richBlockKind(block.lang);
          if (!kind) break;
          if (block.open && streaming) {
            cards.set(block, { kind: "pending", label: kind });
            break;
          }
          const card = shown < MAX_RICH_BLOCKS_PER_REPLY ? parseRichBlock(kind, block.text, sourceCount) : null;
          if (!card) {
            cards.set(block, { kind: "failed" });
            break;
          }
          shown += 1;
          cards.set(block, { kind: "card", block: card });
          citeCard(card);
          break;
        }
        case "rule":
          break;
      }
    }
  };
  walk(blocks);
  return { cards, cited };
}
