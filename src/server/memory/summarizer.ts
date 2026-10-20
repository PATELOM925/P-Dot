import "server-only";
import { z } from "zod";
import type { HistoryMessage } from "@/server/assistant/context";
import type { MemoryCategory, MemoryRepository, UserMemory } from "@/server/db/memories";
import type { ChatMessage, CompletionChunk } from "@/server/providers/nebius/client";

import type { LogFields, LogLevel } from "@/server/log";

export interface ExtractedMemoryItem {
  content: string;
  category: MemoryCategory;
}

export interface SummarizeSessionOptions {
  signal?: AbortSignal;
  /** Similarity threshold above which an existing memory is updated/deduplicated instead of duplicated (default: 0.85). */
  dedupThreshold?: number;
}

export interface SummarizeSessionResult {
  extractedCount: number;
  createdCount: number;
  updatedCount: number;
  memories: UserMemory[];
}

export interface SummarizerDeps {
  complete: (messages: ChatMessage[], signal?: AbortSignal) => AsyncIterable<CompletionChunk>;
  embed: (text: string, signal?: AbortSignal) => Promise<number[]>;
  memoryRepo: MemoryRepository;
  log?: (level: LogLevel, event: string, fields?: LogFields) => void;
}

const memoryCategorySchema = z.enum(["preference", "fact", "work", "personal", "general"]);

const extractedItemSchema = z.object({
  content: z.string().trim().min(3).max(500),
  category: memoryCategorySchema.default("general"),
});

const extractionResultSchema = z.object({
  memories: z.array(extractedItemSchema),
});

export const MEMORY_EXTRACTION_SYSTEM_PROMPT = `You are an episodic memory extraction agent for an AI assistant.
Your job is to read the conversation transcript between the user and the assistant, and extract durable, atomic personal facts about the user.

CATEGORIES TO EXTRACT:
- "preference": Coding styles, frameworks, tone, beverage/food preferences, UI choices (e.g. "Prefers TypeScript strict mode and Tailwind CSS").
- "work": Current projects, tech stack, job role, company, architectures (e.g. "Building a mobile application called P-Dot with Next.js and Supabase").
- "personal": Locations, family, pets, timezones, dietary restrictions, hobbies (e.g. "Lives in Toronto, Eastern Timezone; allergic to shellfish").
- "fact": Hardware, system constraints, verified deadlines, environment details (e.g. "Uses an M3 MacBook Pro with macOS Sequoia").

CRITICAL NEGATIVE RULES (DO NOT EXTRACT):
1. NEVER extract transient questions, trivia, or one-off queries (e.g. "What is the weather?", "How to sort an array in Python?").
2. NEVER extract assistant suggestions or code samples unless the user confirmed or adopted them as their own standard.
3. NEVER extract temporary conversation flow or meeting-style summaries (e.g. "User greeted the assistant", "User asked about debugging").
4. NEVER extract credentials, passwords, or API keys.
5. If the conversation contains NO durable personal facts about the user, output: {"memories": []}.

OUTPUT FORMAT:
Output ONLY valid JSON matching this schema:
{
  "memories": [
    {
      "content": "A concise, atomic fact written in third person (e.g. 'User prefers pnpm over npm for package management')",
      "category": "preference" | "work" | "personal" | "fact"
    }
  ]
}`;

/**
 * Scrubs API keys, bearer tokens, and credentials from text before persistence.
 */
export function scrubSensitiveData(text: string): string {
  return text
    .replace(/(\b(?:sk|ghp|gho|np|sec)[_-][a-zA-Z0-9_\-]{16,}\b)/gi, "[REDACTED_KEY]")
    .replace(/(bearer\s+[a-zA-Z0-9_\-\.]{20,})/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/(password|secret|apikey|api_key)\s*[:=]\s*["']?[^\s"']+["']?/gi, "$1: [REDACTED]");
}

/**
 * Extracts atomic, durable memory items from a multi-turn conversation transcript.
 */
export async function extractSessionMemories(
  transcript: HistoryMessage[],
  complete: (messages: ChatMessage[], signal?: AbortSignal) => AsyncIterable<CompletionChunk>,
  signal?: AbortSignal,
): Promise<ExtractedMemoryItem[]> {
  const userMessages = transcript.filter((m) => m.role === "user");
  if (userMessages.length === 0) return [];

  // Trivial greeting check
  if (
    userMessages.length === 1 &&
    /^(hi|hello|hey|yo|sup)\b/i.test(userMessages[0]!.content.trim()) &&
    userMessages[0]!.content.trim().length < 15
  ) {
    return [];
  }

  const transcriptText = transcript
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const promptMessages: ChatMessage[] = [
    { role: "system", content: MEMORY_EXTRACTION_SYSTEM_PROMPT },
    { role: "user", content: `Here is the conversation transcript:\n\n${transcriptText.slice(0, 12000)}` },
  ];

  let raw = "";
  try {
    for await (const chunk of complete(promptMessages, signal)) {
      if (chunk.type === "text") {
        raw += chunk.text;
      }
    }
  } catch {
    return [];
  }

  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }

  try {
    const json = JSON.parse(cleaned);
    const parsed = extractionResultSchema.safeParse(json);
    if (!parsed.success) return [];

    return parsed.data.memories
      .map((item) => ({
        content: scrubSensitiveData(item.content.trim()),
        category: item.category,
      }))
      .filter((item) => item.content.length >= 3 && !item.content.includes("[REDACTED_KEY]"));
  } catch {
    return [];
  }
}

/**
 * Deduplicates newly extracted memories against existing vector embeddings,
 * updating matching memories when similarity >= dedupThreshold (default 0.85)
 * or creating new entries when novel.
 */
export async function deduplicateAndPersistMemories(
  userId: string,
  items: ExtractedMemoryItem[],
  deps: Pick<SummarizerDeps, "embed" | "memoryRepo" | "log">,
  options: SummarizeSessionOptions = {},
): Promise<{ createdCount: number; updatedCount: number; memories: UserMemory[] }> {
  const dedupThreshold = options.dedupThreshold ?? 0.85;
  let createdCount = 0;
  let updatedCount = 0;
  const memories: UserMemory[] = [];

  for (const item of items) {
    try {
      const embedding = await deps.embed(item.content, options.signal);
      const matches = await deps.memoryRepo.searchMemories(userId, embedding, {
        threshold: 0.65,
        limit: 3,
        category: item.category,
      });

      const topMatch = matches[0];
      if (topMatch && topMatch.similarity >= dedupThreshold) {
        // High similarity: update existing memory rather than duplicating
        const updated = await deps.memoryRepo.updateMemory(userId, topMatch.id, {
          content: item.content,
          category: item.category,
          embedding,
        });
        if (updated) {
          updatedCount += 1;
          memories.push(updated);
        }
      } else {
        // Novel memory: insert as new item
        const created = await deps.memoryRepo.createMemory(userId, {
          content: item.content,
          category: item.category,
          embedding,
        });
        createdCount += 1;
        memories.push(created);
      }
    } catch (err) {
      deps.log?.("warn", "memory_persistence_failed", {
        userId,
        content: item.content,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { createdCount, updatedCount, memories };
}

/**
 * End-to-end episodic session summarization orchestrator.
 */
export async function summarizeSession(
  userId: string,
  transcript: HistoryMessage[],
  deps: SummarizerDeps,
  options: SummarizeSessionOptions = {},
): Promise<SummarizeSessionResult> {
  const items = await extractSessionMemories(transcript, deps.complete, options.signal);
  if (items.length === 0) {
    return { extractedCount: 0, createdCount: 0, updatedCount: 0, memories: [] };
  }

  const { createdCount, updatedCount, memories } = await deduplicateAndPersistMemories(
    userId,
    items,
    deps,
    options,
  );

  deps.log?.("info", "session_summarized", {
    userId,
    extractedCount: items.length,
    createdCount,
    updatedCount,
  });

  return {
    extractedCount: items.length,
    createdCount,
    updatedCount,
    memories,
  };
}
