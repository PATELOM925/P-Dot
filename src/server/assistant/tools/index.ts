import "server-only";
import {
  earlierAttemptCheck,
  proposeReminderTool,
  proposeTaskTool,
  saveMemoryTool,
  searchDocumentsTool,
  searchMemoriesTool,
} from "./own-data";
import type { ToolSpec } from "./registry";
import { webSearchTool } from "./web-search";

export * from "./registry";
export { earlierAttemptCheck };

/** Every tool, in the order the model sees them. Add a new tool here and in `AssistantToolName`. */
export const TOOLS: readonly ToolSpec[] = [
  webSearchTool,
  searchDocumentsTool,
  searchMemoriesTool,
  proposeTaskTool,
  proposeReminderTool,
  saveMemoryTool,
] as ToolSpec[];
