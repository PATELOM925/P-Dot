import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { PrivateSourceActivityDTO } from "@/types/api";
import { RepositoryError } from "./conversations";

const activityRow = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  sources: z.array(z.unknown()),
  created_at: z.string().datetime({ offset: true }),
});

export function mapPrivateSourceActivityRows(rows: unknown[]): PrivateSourceActivityDTO[] {
  return rows.flatMap((row) => {
    const parsed = activityRow.safeParse(row);
    if (!parsed.success) return [];
    const events: PrivateSourceActivityDTO[] = [];
    for (const source of parsed.data.sources) {
      if (!source || typeof source !== "object" || !("__pdot_activity" in source)) continue;
      const activity = z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("connector_read_succeeded"), source: z.enum(["google", "connector"]) }),
        z.object({ kind: z.literal("assistant_search_blocked"), source: z.literal("assistant_search") }),
      ]).safeParse(source.__pdot_activity);
      if (!activity.success) continue;
      events.push({
        id: `${parsed.data.id}:${events.length}`,
        conversationId: parsed.data.conversation_id,
        source: activity.data.source,
        outcome: activity.data.kind === "connector_read_succeeded" ? "read_succeeded" as const : "search_blocked" as const,
        createdAt: parsed.data.created_at,
      });
    }
    return events;
  });
}

export async function listPrivateSourceActivity(
  supabase: SupabaseClient,
  userId: string,
  limit: number,
): Promise<PrivateSourceActivityDTO[]> {
  const markers = [
    { __pdot_activity: { kind: "connector_read_succeeded", source: "google" } },
    { __pdot_activity: { kind: "connector_read_succeeded", source: "connector" } },
    { __pdot_activity: { kind: "assistant_search_blocked", source: "assistant_search" } },
  ];
  const batches = await Promise.all(markers.map((marker) => supabase
    .from("messages")
    .select("id, conversation_id, sources, created_at")
    .eq("user_id", userId)
    .eq("role", "assistant")
    .filter("sources", "cs", JSON.stringify([marker]))
    .order("created_at", { ascending: false })
    .limit(limit)));
  if (batches.some(({ error }) => error)) throw new RepositoryError("listPrivateSourceActivity");
  const rowsById = new Map<string, unknown>();
  for (const row of batches.flatMap(({ data }) => data ?? [])) {
    if (row && typeof row === "object" && "id" in row && typeof row.id === "string") {
      rowsById.set(row.id, row);
    }
  }
  return mapPrivateSourceActivityRows([...rowsById.values()])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}
