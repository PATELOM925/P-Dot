import { z } from "zod";
import { createContextRecordRepository } from "@/server/db/context-records";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

interface Context {
  params: Promise<{ id: string }>;
}

const idSchema = z.uuid();

/** GET /api/messages/:id/context: what the model received for one assistant reply. */
export async function GET(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "messages.context" }, async ({ auth, requestId }) => {
    const notFound = () =>
      errorResponse(404, "not_found", "No context record for this message.", requestId);

    // Malformed IDs, other users' messages and messages without a record all look the same.
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return notFound();

    const record = await createContextRecordRepository(auth.supabase).getContextRecord(auth.userId, id.data);
    if (!record) return notFound();
    return jsonResponse(record, requestId);
  });
}
