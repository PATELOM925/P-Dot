import { MAX_CHAT_BODY_BYTES, REMINDER_LIST_LIMIT } from "@/lib/limits";
import { createReminderSchema, modeSchema } from "@/lib/schemas";
import { createActionLogRepository } from "@/server/db/action-log";
import { createReminderRepository } from "@/server/db/reminders";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

/** GET /api/reminders?mode=personal|work — the signed-in user's reminders for one mode, soonest first. */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "reminders.list" }, async ({ auth, requestId }) => {
    const mode = modeSchema.safeParse(new URL(request.url).searchParams.get("mode"));
    if (!mode.success) return errorResponse(400, "invalid_request", "Choose a mode: personal or work.", requestId);

    const reminders = await createReminderRepository(auth.supabase).listReminders(
      auth.userId,
      mode.data,
      REMINDER_LIST_LIMIT,
    );
    return jsonResponse({ reminders }, requestId);
  });
}

/** POST /api/reminders — add a reminder. Body: { mode, title, dueAt }. */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "reminders.create", sameOrigin: true }, async ({ auth, requestId }) => {
    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = createReminderSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }

    const reminder = await createReminderRepository(auth.supabase).createReminder(auth.userId, parsed.data);
    await createActionLogRepository(auth.supabase).append(auth.userId, "reminder_added", {
      reminderId: reminder.id,
      mode: reminder.mode,
    });
    return jsonResponse(reminder, requestId, { status: 201 });
  });
}
