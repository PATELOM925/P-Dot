import "server-only";
import { z } from "zod";

/** OpenAI-compatible Tool parameter JSON Schema */
export interface ToolFunctionParameter {
  type: "object";
  properties: Record<
    string,
    {
      type: string;
      description?: string;
      enum?: string[];
      items?: { type: string };
    }
  >;
  required?: string[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolFunctionParameter;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Schema for validating the web_search tool argument */
export const webSearchArgsSchema = z.object({
  query: z.string().trim().min(1).max(400),
});

export type WebSearchArgs = z.infer<typeof webSearchArgsSchema>;

/**
 * The web search tool definition exposed to Nebius.
 * The model invokes this autonomously whenever it requires current real-time
 * facts, external news, or domain verification.
 */
export const WEB_SEARCH_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the live web using Tavily for up-to-date facts, breaking news, documentation, or events beyond model training cutoff.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Targeted search keywords or query without punctuation operators.",
        },
      },
      required: ["query"],
    },
  },
};

/** Schema for validating propose_reminder arguments */
export const proposeReminderArgsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  due_at: z.string().trim().min(1).max(100),
  notes: z.string().trim().max(500).optional(),
});

export type ProposeReminderArgs = z.infer<typeof proposeReminderArgsSchema>;

/**
 * Tool definition for proposing a user reminder.
 */
export const PROPOSE_REMINDER_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "propose_reminder",
    description:
      "Propose setting a time-based reminder for the user. Proposes an interactive action card for user confirmation.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Clear, concise title of what to be reminded about (e.g. 'Call dentist', 'Submit expense report').",
        },
        due_at: {
          type: "string",
          description: "When the reminder should trigger (e.g. 'tomorrow at 9:00 AM', '2026-10-21T14:00:00Z').",
        },
        notes: {
          type: "string",
          description: "Optional extra details or context.",
        },
      },
      required: ["title", "due_at"],
    },
  },
};

/** Schema for validating propose_task arguments */
export const proposeTaskArgsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  priority: z.enum(["low", "medium", "high"]).optional(),
  due_date: z.string().trim().max(100).optional(),
});

export type ProposeTaskArgs = z.infer<typeof proposeTaskArgsSchema>;

/**
 * Tool definition for proposing a user task / todo.
 */
export const PROPOSE_TASK_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "propose_task",
    description:
      "Propose adding a task or todo item to the user's task list. Proposes an interactive action card for user confirmation.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Clear, actionable title of the task (e.g. 'Draft quarterly report').",
        },
        priority: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Priority of the task. Defaults to 'medium'.",
        },
        due_date: {
          type: "string",
          description: "Optional due date or deadline (e.g. 'by Friday', '2026-10-25').",
        },
      },
      required: ["title"],
    },
  },
};

/** Schema for validating search_documents arguments */
export const searchDocumentsArgsSchema = z.object({
  query: z.string().trim().min(1).max(400),
});

export type SearchDocumentsArgs = z.infer<typeof searchDocumentsArgsSchema>;

/**
 * Tool definition for searching personal documents and notes.
 * The model invokes this autonomously when asked about personal files, uploaded documents,
 * custom guides, or user-specific knowledge.
 */
export const SEARCH_DOCUMENTS_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "search_documents",
    description:
      "Search the user's uploaded personal documents, notes, reservations, home details, credentials, and files using semantic vector search. Always call this whenever the user asks about their personal information, notes, flight, home, or stored files.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Targeted search keywords or question describing the information needed from personal documents.",
        },
      },
      required: ["query"],
    },
  },
};

