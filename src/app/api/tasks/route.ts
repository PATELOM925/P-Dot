import { MAX_CHAT_BODY_BYTES, TASK_LIST_LIMIT } from "@/lib/limits";
import { createTaskSchema, modeSchema } from "@/lib/schemas";
import { createTaskRepository } from "@/server/db/tasks";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";

/** GET /api/tasks?mode=personal|work — the signed-in user's tasks for one mode. */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "tasks.list" }, async ({ auth, requestId }) => {
    const mode = modeSchema.safeParse(new URL(request.url).searchParams.get("mode"));
    if (!mode.success) return errorResponse(400, "invalid_request", "Choose a mode: personal or work.", requestId);

    const tasks = await createTaskRepository(auth.supabase).listTasks(auth.userId, mode.data, TASK_LIST_LIMIT);
    return jsonResponse({ tasks }, requestId);
  });
}

/** POST /api/tasks — add a task. Body: { mode, title }. */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "tasks.create", sameOrigin: true }, async ({ auth, requestId }) => {
    const body = await readJsonBody(request, MAX_CHAT_BODY_BYTES);
    if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
    const parsed = createTaskSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.", requestId);
    }

    const task = await createTaskRepository(auth.supabase).createTask(auth.userId, parsed.data.mode, parsed.data.title);
    return jsonResponse(task, requestId, { status: 201 });
  });
}
