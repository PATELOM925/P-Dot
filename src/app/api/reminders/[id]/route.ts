import { z } from "zod";
import { MAX_CHAT_BODY_BYTES } from "@/lib/limits";
import { updateReminderSchema } from "@/lib/schemas";
import { createReminderRepository } from "@/server/db/reminders";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

interface Context {
  params: Promise<{ id: string }>;
}

const idSchema = z.uuid();

const reminderNotFound = (requestId: string) => errorResponse(404, "not_found", "Reminder not found.", requestId);

/** PATCH /api/reminders/:id — change a reminder's title, due time or status. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "reminders.update", sameOrigin: true }, async ({ auth, requestId }) => {
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return reminderNotFound(requestId);

    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = updateReminderSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }

    const reminder = await createReminderRepository(auth.supabase).updateReminder(auth.userId, id.data, parsed.data);
    if (!reminder) return reminderNotFound(requestId);
    return jsonResponse(reminder, requestId);
  });
}

/** DELETE /api/reminders/:id — remove a reminder. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "reminders.delete", sameOrigin: true }, async ({ auth, requestId }) => {
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return reminderNotFound(requestId);

    // The database writes the action log row for the delete.
    const deleted = await createReminderRepository(auth.supabase).deleteReminder(auth.userId, id.data);
    if (!deleted) return reminderNotFound(requestId);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
  });
}
