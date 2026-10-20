import { describe, expect, it } from "vitest";
import { prepareChatTurn, streamChatTurn } from "@/server/assistant/service";
import type { ChatRequest } from "@/types/api";
import { createMockMemoryRepository, type MemoryCategory } from "@/server/db/memories";
import { MemoryRepository, fakeDeps } from "../support/fakes";
import { collect } from "../support/streams";

const USER_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_USER_ID = "99999999-8888-7777-6666-555555555555";

async function runTurn(deps: ReturnType<typeof fakeDeps>["deps"], request: ChatRequest) {
  const prepared = await prepareChatTurn(deps, { userId: USER_ID, requestId: "req-memory-test", request });
  if (!prepared.ok) throw new Error(`Prepare failed: ${prepared.message}`);
  const events = await collect(streamChatTurn(deps, prepared.turn, new AbortController().signal));
  return { prepared, events };
}

describe("AI-06: Long-Term Memory System", () => {
  describe("MemoryRepository CRUD & Semantic Search", () => {
    it("creates, lists, retrieves, and deletes memory items with category filtering", async () => {
      const repo = createMockMemoryRepository();

      const mem1 = await repo.createMemory(USER_ID, {
        content: "Prefers light roast Ethiopian coffee with oat milk",
        category: "preference",
        embedding: [1, 0, 0, 0],
      });
      expect(mem1.id).toBeDefined();
      expect(mem1.content).toContain("Ethiopian coffee");
      expect(mem1.category).toBe("preference");

      const mem2 = await repo.createMemory(USER_ID, {
        content: "Born in Austin, Texas and moved to Toronto in 2021",
        category: "personal",
        embedding: [0, 1, 0, 0],
      });

      // List all
      const all = await repo.listMemories(USER_ID);
      expect(all).toHaveLength(2);

      // Filter by category
      const prefsOnly = await repo.listMemories(USER_ID, { category: "preference" });
      expect(prefsOnly).toHaveLength(1);
      expect(prefsOnly[0]?.id).toBe(mem1.id);

      // Get by ID
      const fetched = await repo.getMemory(USER_ID, mem1.id);
      expect(fetched?.content).toBe(mem1.content);

      // Delete
      const deleted = await repo.deleteMemory(USER_ID, mem1.id);
      expect(deleted).toBe(true);

      const remaining = await repo.listMemories(USER_ID);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe(mem2.id);
    });

    it("searches memories using vector cosine similarity and respects category filters", async () => {
      const repo = createMockMemoryRepository([
        {
          userId: USER_ID,
          content: "Dog named Barley is a golden retriever born in 2020",
          category: "personal",
          embedding: [0.9, 0.1, 0.0, 0.0],
        },
        {
          userId: USER_ID,
          content: "Works as a senior distributed systems architect at Acme Corp",
          category: "work",
          embedding: [0.0, 0.1, 0.95, 0.0],
        },
        {
          userId: OTHER_USER_ID,
          content: "Secret other user memory that must never leak",
          category: "personal",
          embedding: [0.95, 0.1, 0.0, 0.0],
        },
      ]);

      // Query about pets
      const matches = await repo.searchMemories(USER_ID, [1.0, 0.0, 0.0, 0.0], {
        threshold: 0.5,
        limit: 5,
      });

      expect(matches).toHaveLength(1);
      expect(matches[0]?.content).toContain("Barley");
      expect(matches[0]?.category).toBe("personal");
      expect(matches[0]?.similarity).toBeGreaterThan(0.85);

      // Confirm Other User memory was strictly isolated
      const leaked = matches.find((m) => m.content.includes("Secret other user"));
      expect(leaked).toBeUndefined();

      // Category filtered search
      const workMatches = await repo.searchMemories(USER_ID, [0.0, 0.0, 1.0, 0.0], {
        threshold: 0.5,
        category: "work",
      });
      expect(workMatches).toHaveLength(1);
      expect(workMatches[0]?.content).toContain("distributed systems");
    });
  });

  describe("Hybrid Memory Context Pre-retrieval", () => {
    it("automatically pre-retrieves relevant memories and injects them into the system prompt", async () => {
      const memRepo = createMockMemoryRepository([
        {
          userId: USER_ID,
          content: "User is strictly vegan and allergic to tree nuts",
          category: "preference",
          embedding: [1, 0, 0, 0],
        },
      ]);

      const repo = new MemoryRepository();
      let capturedSystemPrompt = "";

      const { deps } = fakeDeps({
        repo,
        memoryRepo: memRepo,
        embed: async () => [1, 0, 0, 0], // Query is semantically aligned with dietary restriction
        reply: async function* (messages) {
          const sys = messages.find((m) => m.role === "system")?.content ?? "";
          if (sys.includes("P-Dot")) {
            capturedSystemPrompt = sys;
          }
          yield {
            type: "text" as const,
            text: "Since you are strictly vegan and allergic to tree nuts, I recommend an oat milk berry smoothie.",
          };
          yield { type: "finish" as const, finishReason: "stop", usage: null };
        },
      });

      const { events } = await runTurn(deps, {
        action: "send",
        message: "What breakfast smoothie should I make this morning?",
        webSearch: false,
      });

      expect(capturedSystemPrompt).toContain("<relevant_memories>");
      expect(capturedSystemPrompt).toContain("User is strictly vegan and allergic to tree nuts");
      expect(capturedSystemPrompt).toContain("[preference]");

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      if (doneEvent && doneEvent.type === "done") {
        expect(doneEvent.message.content).toContain("oat milk berry smoothie");
      }
    });
  });

  describe("Autonomous Memory Tool Execution", () => {
    it("calls save_memory to persist a user preference to long-term storage", async () => {
      const memRepo = createMockMemoryRepository();
      const repo = new MemoryRepository();
      let pass = 0;

      const { deps } = fakeDeps({
        repo,
        memoryRepo: memRepo,
        embed: async () => [0.5, 0.5, 0.5, 0.5],
        reply: async function* (messages) {
          pass += 1;
          if (pass === 1) {
            yield {
              type: "tool_calls" as const,
              calls: [
                {
                  id: "call_save_editor_pref",
                  type: "function" as const,
                  function: {
                    name: "save_memory",
                    arguments: JSON.stringify({
                      content: "Prefers Neovim with Lua config over VS Code",
                      category: "preference",
                    }),
                  },
                },
              ],
            };
            yield { type: "finish" as const, finishReason: "tool_calls", usage: null };
          } else {
            const toolMsg = messages.find((m) => m.role === "tool");
            expect(toolMsg?.content).toContain("Memory saved");

            yield {
              type: "text" as const,
              text: "Got it! I've remembered that you prefer Neovim with Lua configuration.",
            };
            yield { type: "finish" as const, finishReason: "stop", usage: null };
          }
        },
      });

      const { events } = await runTurn(deps, {
        action: "send",
        message: "Remember that I prefer Neovim with Lua configuration over VS Code.",
        webSearch: false,
      });

      // Verify thought event was emitted
      const thoughtEvent = events.find((e) => e.type === "thought");
      expect(thoughtEvent).toBeDefined();

      // Verify memory was saved in repository
      const savedMemories = await memRepo.listMemories(USER_ID);
      expect(savedMemories).toHaveLength(1);
      expect(savedMemories[0]?.content).toBe("Prefers Neovim with Lua config over VS Code");
      expect(savedMemories[0]?.category).toBe("preference");

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      if (doneEvent && doneEvent.type === "done") {
        expect(doneEvent.message.content).toContain("Neovim");
      }
    });

    it("calls search_memories to recall past details when requested", async () => {
      const memRepo = createMockMemoryRepository([
        {
          userId: USER_ID,
          content: "Favorite coffee shop is Pilot Coffee Roasters on Ossington Ave",
          category: "personal",
          embedding: [1, 0, 0, 0],
        },
      ]);
      const repo = new MemoryRepository();
      let pass = 0;

      const { deps } = fakeDeps({
        repo,
        memoryRepo: memRepo,
        embed: async () => [1, 0, 0, 0],
        reply: async function* (messages) {
          pass += 1;
          if (pass === 1) {
            yield {
              type: "tool_calls" as const,
              calls: [
                {
                  id: "call_search_coffee",
                  type: "function" as const,
                  function: {
                    name: "search_memories",
                    arguments: JSON.stringify({ query: "favorite coffee shop" }),
                  },
                },
              ],
            };
            yield { type: "finish" as const, finishReason: "tool_calls", usage: null };
          } else {
            const toolMsg = messages.find((m) => m.role === "tool");
            expect(toolMsg?.content).toContain("Pilot Coffee Roasters");

            yield {
              type: "text" as const,
              text: "Your favorite coffee shop is Pilot Coffee Roasters on Ossington Ave.",
            };
            yield { type: "finish" as const, finishReason: "stop", usage: null };
          }
        },
      });

      const { events } = await runTurn(deps, {
        action: "send",
        message: "Where is my favorite coffee shop?",
        webSearch: false,
      });

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      if (doneEvent && doneEvent.type === "done") {
        expect(doneEvent.message.content).toContain("Pilot Coffee Roasters on Ossington Ave");
      }
    });
  });
});
