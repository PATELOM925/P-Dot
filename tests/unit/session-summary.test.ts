import { describe, expect, it } from "vitest";
import type { HistoryMessage } from "@/server/assistant/context";
import { createMockMemoryRepository } from "@/server/db/memories";
import {
  deduplicateAndPersistMemories,
  extractSessionMemories,
  scrubSensitiveData,
  summarizeSession,
  type ExtractedMemoryItem,
} from "@/server/memory/summarizer";
import type { ChatMessage, CompletionChunk } from "@/server/providers/nebius/client";

const USER_ID = "00000000-0000-0000-0000-111111111111";

function mockCompletion(output: string) {
  return async function* (): AsyncIterable<CompletionChunk> {
    yield { type: "text", text: output };
    yield { type: "finish", finishReason: "stop", usage: null };
  };
}

describe("AI-06b: Episodic Session Summarization", () => {
  describe("scrubSensitiveData", () => {
    it("redacts API keys, bearer tokens, and passwords", () => {
      const sensitive =
        "My API key is sk-1234567890abcdef1234567890 and Bearer eyJhbGciOiJIUzI1NiIsInR5cCI. password: mySecretPassword123";
      const scrubbed = scrubSensitiveData(sensitive);

      expect(scrubbed).not.toContain("sk-1234567890abcdef1234567890");
      expect(scrubbed).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI");
      expect(scrubbed).not.toContain("mySecretPassword123");
      expect(scrubbed).toContain("[REDACTED_KEY]");
      expect(scrubbed).toContain("Bearer [REDACTED_TOKEN]");
      expect(scrubbed).toContain("password: [REDACTED]");
    });
  });

  describe("extractSessionMemories", () => {
    it("extracts atomic personal facts across categories from multi-turn transcript", async () => {
      const transcript: HistoryMessage[] = [
        { role: "user", content: "Hey! I am working on my mobile app called P-Dot." },
        { role: "assistant", content: "Great! What tech stack are you using for P-Dot?" },
        {
          role: "user",
          content:
            "We are using Next.js 15 with Supabase. I really prefer TypeScript strict mode and avoid using CSS modules.",
        },
        { role: "assistant", content: "Understood. Strict TypeScript and standard CSS or Tailwind is a solid choice." },
        {
          role: "user",
          content: "Also, I'm based in Toronto so make sure all time scheduling is in Eastern Time (EST).",
        },
      ];

      const modelJson = JSON.stringify({
        memories: [
          {
            content: "User is building a mobile application called P-Dot using Next.js 15 and Supabase.",
            category: "work",
          },
          {
            content: "User strongly prefers TypeScript strict mode and dislikes CSS modules.",
            category: "preference",
          },
          {
            content: "User is based in Toronto and operates in Eastern Time (EST).",
            category: "personal",
          },
        ],
      });

      const extracted = await extractSessionMemories(transcript, mockCompletion(`\`\`\`json\n${modelJson}\n\`\`\``));

      expect(extracted).toHaveLength(3);
      expect(extracted[0]?.category).toBe("work");
      expect(extracted[0]?.content).toContain("P-Dot");
      expect(extracted[1]?.category).toBe("preference");
      expect(extracted[1]?.content).toContain("TypeScript strict mode");
      expect(extracted[2]?.category).toBe("personal");
      expect(extracted[2]?.content).toContain("Toronto");
    });

    it("returns empty array for transient questions or empty conversations", async () => {
      const transcript: HistoryMessage[] = [
        { role: "user", content: "What is the capital of France?" },
        { role: "assistant", content: "The capital of France is Paris." },
      ];

      const extracted = await extractSessionMemories(
        transcript,
        mockCompletion(JSON.stringify({ memories: [] })),
      );

      expect(extracted).toEqual([]);
    });

    it("skips extraction for single trivial greeting", async () => {
      const transcript: HistoryMessage[] = [{ role: "user", content: "hi" }];

      let called = false;
      const complete = async function* () {
        called = true;
        yield { type: "text" as const, text: "{}" };
      };

      const extracted = await extractSessionMemories(transcript, complete);
      expect(called).toBe(false);
      expect(extracted).toEqual([]);
    });

    it("discards extracted items that contain redacted API keys", async () => {
      const transcript: HistoryMessage[] = [
        { role: "user", content: "Here is my key: sk-abcdef1234567890abcdef12345678" },
      ];

      const modelJson = JSON.stringify({
        memories: [
          {
            content: "User API key is sk-abcdef1234567890abcdef12345678",
            category: "fact",
          },
        ],
      });

      const extracted = await extractSessionMemories(transcript, mockCompletion(modelJson));
      expect(extracted).toHaveLength(0);
    });
  });

  describe("deduplicateAndPersistMemories", () => {
    it("creates a new memory when similarity is below threshold", async () => {
      const repo = createMockMemoryRepository();
      const mockEmbed = async () => [1, 0, 0, 0];

      const items: ExtractedMemoryItem[] = [
        { content: "User is allergic to peanuts and tree nuts", category: "personal" },
      ];

      const result = await deduplicateAndPersistMemories(USER_ID, items, {
        embed: mockEmbed,
        memoryRepo: repo,
      });

      expect(result.createdCount).toBe(1);
      expect(result.updatedCount).toBe(0);
      expect(result.memories).toHaveLength(1);
      expect(result.memories[0]?.content).toContain("peanuts");

      const stored = await repo.listMemories(USER_ID);
      expect(stored).toHaveLength(1);
    });

    it("updates existing memory instead of creating a duplicate when similarity >= 0.85", async () => {
      // Existing memory in DB with embedding [1, 0, 0, 0]
      const repo = createMockMemoryRepository([
        {
          id: "mem-existing-1",
          userId: USER_ID,
          content: "User prefers npm package manager",
          category: "preference",
          embedding: [1, 0, 0, 0],
        },
      ]);

      // New item has exact same or very close vector [0.99, 0.01, 0, 0]
      const mockEmbed = async () => [0.99, 0.01, 0, 0];

      const items: ExtractedMemoryItem[] = [
        { content: "User switched and now prefers pnpm over npm", category: "preference" },
      ];

      const result = await deduplicateAndPersistMemories(
        USER_ID,
        items,
        {
          embed: mockEmbed,
          memoryRepo: repo,
        },
        { dedupThreshold: 0.85 },
      );

      expect(result.createdCount).toBe(0);
      expect(result.updatedCount).toBe(1);
      expect(result.memories).toHaveLength(1);
      expect(result.memories[0]?.id).toBe("mem-existing-1");
      expect(result.memories[0]?.content).toBe("User switched and now prefers pnpm over npm");

      // Verify the repo only has 1 record, updated in place
      const stored = await repo.listMemories(USER_ID);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.content).toBe("User switched and now prefers pnpm over npm");
    });
  });

  describe("summarizeSession Orchestrator", () => {
    it("runs complete end-to-end extraction and persistence flow", async () => {
      const repo = createMockMemoryRepository();
      const mockEmbed = async () => [0.5, 0.5, 0.5, 0.5];

      const transcript: HistoryMessage[] = [
        { role: "user", content: "I work as a site reliability engineer at Datadog." },
        { role: "assistant", content: "Nice to meet you! How can I assist with your SRE workflows?" },
        { role: "user", content: "I prefer bash scripts over python for quick automation." },
      ];

      const modelJson = JSON.stringify({
        memories: [
          { content: "User works as a site reliability engineer at Datadog.", category: "work" },
          { content: "User prefers bash scripts over python for quick automation.", category: "preference" },
        ],
      });

      const logs: Array<{ level: string; event: string }> = [];
      const log = (level: "info" | "warn" | "error", event: string) => {
        logs.push({ level, event });
      };

      const result = await summarizeSession(
        USER_ID,
        transcript,
        {
          complete: mockCompletion(modelJson),
          embed: mockEmbed,
          memoryRepo: repo,
          log,
        },
        { dedupThreshold: 0.85 },
      );

      expect(result.extractedCount).toBe(2);
      expect(result.createdCount).toBe(2);
      expect(result.updatedCount).toBe(0);
      expect(result.memories).toHaveLength(2);

      const inRepo = await repo.listMemories(USER_ID);
      expect(inRepo).toHaveLength(2);
      expect(logs.some((l) => l.event === "session_summarized")).toBe(true);
    });
  });
});
