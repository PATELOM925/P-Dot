import "server-only";
import type { ToolSpec } from "./registry";
import { webSearchTool } from "./web-search";

export * from "./registry";

/** Every tool, in the order the model sees them. Add a new tool here and in `AssistantToolName`. */
export const TOOLS: readonly ToolSpec[] = [webSearchTool as ToolSpec];
