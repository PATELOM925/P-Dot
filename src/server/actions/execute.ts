import "server-only";
import { EmbeddingBudgetError, type Embedder } from "@/server/assistant/embed";
import type { MemoryRepository } from "@/server/db/memories";
import type { ReminderRepository } from "@/server/db/reminders";
import type { TaskRepository } from "@/server/db/tasks";
import { logEvent } from "@/server/log";
import { ProviderError } from "@/server/providers/errors";
import type { ActionPayload } from "@/types/api";

/**
 * Runs one approved action. The route calls this only after the user approves
 * the proposal. These kinds change only P-Dot's own data. Do not add a kind
 * that sends email, changes a calendar or touches a device without a new
 * decision (decision 0009).
 */
export interface ActionDeps {
  tasks: Pick<TaskRepository, "createTask">;
  reminders: Pick<ReminderRepository, "createReminder">;
  memories: Pick<MemoryRepository, "createMemory">;
  /** Optional. A memory is saved without a vector when this is missing or fails. */
  embedder?: Embedder | null;
}

/** IDs only. Never text. */
export type ActionResult = Record<string, string>;

export async function executeAction(
  userId: string,
  proposalId: string,
  payload: ActionPayload,
  deps: ActionDeps,
): Promise<ActionResult> {
  switch (payload.kind) {
    case "create_task": {
      const task = await deps.tasks.createTask(userId, payload.mode, payload.title);
      return { taskId: task.id };
    }
    case "create_reminder": {
      const reminder = await deps.reminders.createReminder(userId, {
        mode: payload.mode,
        title: payload.title,
        dueAt: payload.dueAt,
        proposalId,
      });
      return { reminderId: reminder.id };
    }
    case "save_memory": {
      // The user approved this memory, so it starts as active. The source is the assistant.
      const embedding = await embedBestEffort(deps.embedder ?? null, proposalId, payload.content);
      const memory = await deps.memories.createMemory(
        userId,
        { mode: payload.mode, content: payload.content, status: "active", source: "assistant", sourceMessageId: null },
        embedding,
      );
      return { memoryId: memory.id };
    }
    default:
      throw new Error("This kind of action is not supported.");
  }
}

/**
 * Same rule as the memories API: a budget refusal or a provider failure saves
 * the memory without a vector. Other errors (for example missing settings)
 * stop the action. The log line holds IDs and error names only, never the text.
 */
async function embedBestEffort(embedder: Embedder | null, proposalId: string, text: string): Promise<number[] | null> {
  if (!embedder) return null;
  try {
    const [vector] = await embedder.embed([text]);
    return vector ?? null;
  } catch (error) {
    if (error instanceof EmbeddingBudgetError || error instanceof ProviderError) {
      logEvent("warn", "action_embedding_failed", { proposalId, errorName: error.name });
      return null;
    }
    throw error;
  }
}
