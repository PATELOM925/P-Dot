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
