import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { PrivateSourceActivityDTO } from "@/types/api";
import { RepositoryError } from "./conversations";

const activityRow = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  route_reason: z.enum(["google_request", "connector_read"]),
  created_at: z.string().datetime({ offset: true }),
});

export function mapPrivateSourceActivityRows(rows: unknown[]): PrivateSourceActivityDTO[] {
  return rows.flatMap((row) => {
    const parsed = activityRow.safeParse(row);
    if (!parsed.success) return [];
    return [{
      id: parsed.data.id,
      conversationId: parsed.data.conversation_id,
      source: parsed.data.route_reason,
      createdAt: parsed.data.created_at,
    }];
  });
}

export async function listPrivateSourceActivity(
  supabase: SupabaseClient,
  userId: string,
  limit: number,
): Promise<PrivateSourceActivityDTO[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, conversation_id, route_reason, created_at")
    .eq("user_id", userId)
    .eq("role", "assistant")
    .in("route_reason", ["google_request", "connector_read"])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new RepositoryError("listPrivateSourceActivity");
  return mapPrivateSourceActivityRows(data ?? []);
}
