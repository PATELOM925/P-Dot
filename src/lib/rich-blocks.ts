import { z } from "zod";

// Fenced blocks that a reply can use to show a card: ```pdot-places {json}```.
// The body is strict JSON checked against a strict schema. A block that fails
// shows as a plain code block. No field takes a URL: P-Dot builds every link.

export const RICH_BLOCK_KINDS = ["places", "table", "checklist", "steps"] as const;
export type RichBlockKind = (typeof RICH_BLOCK_KINDS)[number];

export const MAX_RICH_BLOCK_CHARS = 6000;
export const MAX_RICH_BLOCKS_PER_REPLY = 3;

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** A lone UTF-16 surrogate: not valid text, and `encodeURIComponent` throws on it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Removes control characters and lone surrogates, so every card string is well-formed text. */
export function cleanCardText(value: string): string {
  return value.replace(CONTROL, "").replace(LONE_SURROGATE, "").trim();
}

const text = (max: number) =>
  z
    .string()
    .transform(cleanCardText)
    .pipe(z.string().min(1).max(max));
const cite = z.array(z.int().min(1).max(50)).max(3).optional();
const title = text(80).optional();

export const placesBlock = z.strictObject({
  title,
  items: z
    .array(
      z.strictObject({
        name: text(80),
        kind: text(40).optional(),
        area: text(60).optional(),
        city: text(60).optional(),
        note: text(160).optional(),
        cite,
      }),
    )
    .min(1)
    .max(8),
});

export const tableBlock = z
  .strictObject({
    title,
    columns: z.array(text(40)).min(2).max(6),
    rows: z
      .array(
        z.strictObject({
          cells: z.array(z.union([text(120), z.number().finite(), z.null()])).min(2).max(6),
          cite,
        }),
      )
      .min(1)
      .max(20),
  })
  .refine((table) => table.rows.every((row) => row.cells.length === table.columns.length), { message: "row length" });

export const checklistBlock = z.strictObject({
  title,
  items: z.array(z.strictObject({ text: text(140), done: z.boolean().optional() })).min(1).max(15),
});

export const stepsBlock = z.strictObject({
  title,
  items: z
    .array(
      z.strictObject({
        title: text(80),
        detail: text(240).optional(),
        when: text(40).optional(),
        cite,
      }),
    )
    .min(2)
    .max(12),
});

export type PlacesBlock = z.infer<typeof placesBlock>;
export type TableBlock = z.infer<typeof tableBlock>;
export type ChecklistBlock = z.infer<typeof checklistBlock>;
export type StepsBlock = z.infer<typeof stepsBlock>;

export type RichBlock =
  | { kind: "places"; data: PlacesBlock }
  | { kind: "table"; data: TableBlock }
  | { kind: "checklist"; data: ChecklistBlock }
  | { kind: "steps"; data: StepsBlock };

/** The block kind of a code fence info string ("pdot-places", "pdot:places", "pdot places"), or null. */
export function richBlockKind(info: string): RichBlockKind | null {
  const match = /^pdot[-: ]([a-z]+)$/.exec(info.trim().toLowerCase());
  const kind = match?.[1];
  return kind && (RICH_BLOCK_KINDS as readonly string[]).includes(kind) ? (kind as RichBlockKind) : null;
}

function dropCites(cites: number[] | undefined, sourceCount: number): number[] | undefined {
  const kept = cites?.filter((n) => n <= sourceCount);
  return kept && kept.length > 0 ? kept : undefined;
}

/** Validates a block body. Null when it is too long, not JSON, or not the schema. Cites above `sourceCount` are removed. */
export function parseRichBlock(kind: RichBlockKind, body: string, sourceCount: number): RichBlock | null {
  if (body.length > MAX_RICH_BLOCK_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  switch (kind) {
    case "places": {
      const parsed = placesBlock.safeParse(value);
      if (!parsed.success) return null;
      const items = parsed.data.items.map((item) => ({ ...item, cite: dropCites(item.cite, sourceCount) }));
      return { kind, data: { ...parsed.data, items } };
    }
    case "table": {
      const parsed = tableBlock.safeParse(value);
      if (!parsed.success) return null;
      const rows = parsed.data.rows.map((row) => ({ ...row, cite: dropCites(row.cite, sourceCount) }));
      return { kind, data: { ...parsed.data, rows } };
    }
    case "checklist": {
      const parsed = checklistBlock.safeParse(value);
      return parsed.success ? { kind, data: parsed.data } : null;
    }
    case "steps": {
      const parsed = stepsBlock.safeParse(value);
      if (!parsed.success) return null;
      const items = parsed.data.items.map((item) => ({ ...item, cite: dropCites(item.cite, sourceCount) }));
      return { kind, data: { ...parsed.data, items } };
    }
  }
}
