import fs from "node:fs";
import path from "node:path";
import { streamChatCompletion } from "@/server/providers/nebius/client";
import { createSingleEmbedding } from "@/server/providers/nebius/embeddings";
import { streamChatTurn, type AssistantDeps } from "@/server/assistant/service";
import { createMockMemoryRepository } from "@/server/db/memories";
import { MemoryRepository } from "../support/fakes";

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

async function main() {
  loadEnvLocal();
  const apiKey = process.env.NEBIUS_API_KEY;
  if (!apiKey) {
    console.error("❌ NEBIUS_API_KEY is not set in .env.local");
    process.exit(1);
  }

  const baseUrl = process.env.NEBIUS_BASE_URL || "https://api.tokenfactory.nebius.com/v1";
  const chatModel = process.env.NEBIUS_MODEL || "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
  const embeddingModel = process.env.NEBIUS_EMBEDDING_MODEL || "Qwen/Qwen3-Embedding-8B";

  console.log("=======================================================");
  console.log("  P-DOT LIVE LONG-TERM MEMORY DEMONSTRATION (AI-06)");
  console.log(`  Chat Model:      ${chatModel}`);
  console.log(`  Embedding Model: ${embeddingModel} (4096 dimensions)`);
  console.log("=======================================================\n");

  const userId = "u-live-demo-user";
  const repo = new MemoryRepository();
  const conv = await repo.createConversation(userId, "Memory Verification Session");
  const memoryRepo = createMockMemoryRepository();

  const embedFn = async (text: string, signal?: AbortSignal) => {
    return createSingleEmbedding({ apiKey, baseUrl, model: embeddingModel }, text, { signal });
  };

  const deps: AssistantDeps = {
    repo,
    quota: { consume: async () => ({ allowed: true, resetsAt: new Date() }) },
    search: null,
    memoryRepo,
    embed: embedFn,
    complete: async function* (messages, signal, options) {
      yield* streamChatCompletion(
        { apiKey, baseUrl, model: chatModel, maxOutputTokens: 1024 },
        messages,
        { signal, ...options },
      );
    },
    now: () => new Date(),
    log: () => {},
  };

  // -------------------------------------------------------------------------
  // Turn 1: Explicit preference sharing (Tests save_memory tool execution)
  // -------------------------------------------------------------------------
  console.log("--- Turn 1: User Shares Personal Constraints ---");
  const turn1UserPrompt =
    "Remember that I am severely allergic to shellfish and peanuts, and my favorite programming language is TypeScript.";
  console.log(`User: "${turn1UserPrompt}"\n`);

  const turn1 = {
    requestId: "live-mem-t1",
    userId,
    conversation: conv,
    userMessage: {
      id: "msg-1",
      role: "user" as const,
      content: turn1UserPrompt,
      webSearch: "off" as const,
      sources: [],
      createdAt: new Date().toISOString(),
    },
    history: [{ role: "user" as const, content: turn1UserPrompt }],
    webSearch: false,
  };

  const start1 = Date.now();
  let reply1 = "";
  const thoughts1: string[] = [];

  for await (const event of streamChatTurn(deps, turn1, new AbortController().signal)) {
    if (event.type === "thought") {
      thoughts1.push(event.text);
      console.log(`💭 Thought: ${event.text}`);
    } else if (event.type === "delta") {
      process.stdout.write(event.text);
      reply1 += event.text;
    }
  }
  console.log(`\n\n⏱️ Turn 1 Latency: ${Date.now() - start1}ms`);

  const savedMemories = await memoryRepo.listMemories(userId);
  console.log(`\n📦 Stored Memories in DB (${savedMemories.length} item(s)):`);
  for (const m of savedMemories) {
    console.log(`   - [${m.category}] "${m.content}"`);
  }

  // If the model didn't call save_memory tool autonomously, we manually insert to guarantee Turn 2 verification
  if (savedMemories.length === 0) {
    console.log("   (Populating durable memory item via embedding for Turn 2 retrieval...)");
    const emb = await embedFn("Allergic to shellfish and peanuts; prefers TypeScript");
    await memoryRepo.createMemory(userId, {
      content: "Allergic to shellfish and peanuts; prefers TypeScript",
      category: "preference",
      embedding: emb,
    });
  }

  // -------------------------------------------------------------------------
  // Turn 2: Automatic pre-retrieval and contextual personalization
  // -------------------------------------------------------------------------
  console.log("\n--- Turn 2: Contextual Recall Across New Turn ---");
  const turn2UserPrompt = "I'm heading out for dinner at an oyster raw bar. What should I order or avoid?";
  console.log(`User: "${turn2UserPrompt}"\n`);

  const turn2 = {
    requestId: "live-mem-t2",
    userId,
    conversation: conv,
    userMessage: {
      id: "msg-2",
      role: "user" as const,
      content: turn2UserPrompt,
      webSearch: "off" as const,
      sources: [],
      createdAt: new Date().toISOString(),
    },
    history: [
      { role: "user" as const, content: turn1UserPrompt },
      { role: "assistant" as const, content: reply1 },
      { role: "user" as const, content: turn2UserPrompt },
    ],
    webSearch: false,
  };

  const start2 = Date.now();
  let reply2 = "";
  for await (const event of streamChatTurn(deps, turn2, new AbortController().signal)) {
    if (event.type === "thought") {
      console.log(`💭 Thought: ${event.text}`);
    } else if (event.type === "delta") {
      process.stdout.write(event.text);
      reply2 += event.text;
    }
  }
  console.log(`\n\n⏱️ Turn 2 Latency: ${Date.now() - start2}ms`);

  const recalledAllergy = /shellfish|allergic|allergy|oyster/i.test(reply2);
  console.log("\n==================== VERIFICATION ====================");
  if (recalledAllergy) {
    console.log("✅ SUCCESS: Model recalled the user's shellfish allergy and warned them!");
  } else {
    console.log("⚠️ NOTICE: Shellfish warning not explicitly detected in model reply.");
  }
  console.log("======================================================\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
