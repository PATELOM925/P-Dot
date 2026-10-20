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

/** Schema for validating save_memory arguments */
export const saveMemoryArgsSchema = z.object({
  content: z.string().trim().min(1).max(1000),
  category: z.enum(["preference", "fact", "work", "personal", "general"]).default("general"),
});

export type SaveMemoryArgs = z.infer<typeof saveMemoryArgsSchema>;

/**
 * Tool definition for saving a new durable memory item.
 * The model calls this when the user explicitly or implicitly shares a lasting personal fact,
 * preference, constraint, or detail that should be remembered across conversations.
 */
export const SAVE_MEMORY_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "save_memory",
    description:
      "Save a durable personal memory, preference, habit, or biographical fact about the user for future conversations. Call this whenever the user shares personal preferences ('I prefer dark roast', 'I am allergic to gluten'), work details ('I work on the billing team'), or asks you to remember something.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description:
            "A concise, atomic factual statement summarizing what to remember (e.g. 'Prefers dark roast coffee with oat milk', 'Allergic to gluten', 'Works as a backend engineer').",
        },
        category: {
          type: "string",
          enum: ["preference", "fact", "work", "personal", "general"],
          description: "Category of the memory. Defaults to 'general'.",
        },
      },
      required: ["content"],
    },
  },
};

/** Schema for validating search_memories arguments */
export const searchMemoriesArgsSchema = z.object({
  query: z.string().trim().min(1).max(400),
  category: z.enum(["preference", "fact", "work", "personal", "general"]).optional(),
});

export type SearchMemoriesArgs = z.infer<typeof searchMemoriesArgsSchema>;

/**
 * Tool definition for retrieving past memories and user preferences.
 */
export const SEARCH_MEMORIES_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "search_memories",
    description:
      "Search the user's saved personal memories, preferences, work background, and habits using semantic vector search. Call this when you need context about user preferences, personal details, or past stated constraints.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Targeted search keywords or topic to search within user memories.",
        },
        category: {
          type: "string",
          enum: ["preference", "fact", "work", "personal", "general"],
          description: "Optional filter by category.",
        },
      },
      required: ["query"],
    },
  },
};
