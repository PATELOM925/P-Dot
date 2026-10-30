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
import { GOOGLE_TOOLS } from "./google";

export * from "./registry";
export { earlierAttemptCheck };
export { newGoogleTurn, type GoogleServices, type GoogleTurn } from "./google";

/** Every tool, in the order the model sees them. Add a new tool here and in `AssistantToolName`. */
export const TOOLS: readonly ToolSpec[] = [
  webSearchTool,
  searchDocumentsTool,
  searchMemoriesTool,
  proposeTaskTool,
  proposeReminderTool,
  saveMemoryTool,
  ...GOOGLE_TOOLS,
] as ToolSpec[];
