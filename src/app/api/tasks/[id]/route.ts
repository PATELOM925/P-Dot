import { z } from "zod";
import { MAX_CHAT_BODY_BYTES } from "@/lib/limits";
import { updateTaskSchema } from "@/lib/schemas";
import { createTaskRepository } from "@/server/db/tasks";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

interface Context {
  params: Promise<{ id: string }>;
}

const idSchema = z.uuid();

const taskNotFound = (requestId: string) => errorResponse(404, "not_found", "Task not found.", requestId);

/** PATCH /api/tasks/:id — change a task's title or done state. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "tasks.update", sameOrigin: true }, async ({ auth, requestId }) => {
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return taskNotFound(requestId);

    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = updateTaskSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }

    const task = await createTaskRepository(auth.supabase).updateTask(auth.userId, id.data, parsed.data);
    if (!task) return taskNotFound(requestId);
    return jsonResponse(task, requestId);
  });
}

/** DELETE /api/tasks/:id — remove a task. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "tasks.delete", sameOrigin: true }, async ({ auth, requestId }) => {
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return taskNotFound(requestId);

    const deleted = await createTaskRepository(auth.supabase).deleteTask(auth.userId, id.data);
    if (!deleted) return taskNotFound(requestId);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
  });
}
