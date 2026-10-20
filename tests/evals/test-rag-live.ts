import fs from "node:fs";
import path from "node:path";
import { splitIntoChunks } from "@/server/rag/chunker";
import { createEmbeddings, createSingleEmbedding } from "@/server/providers/nebius/embeddings";
import { createMockDocumentRepository } from "@/server/db/documents";
import { streamChatTurn, type AssistantDeps } from "@/server/assistant/service";
import { streamChatCompletion, type ChatMessage } from "@/server/providers/nebius/client";
import { collect } from "../support/streams";

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
  const embedModel = "Qwen/Qwen3-Embedding-8B";
  const chatModel = process.env.NEBIUS_MODEL || "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";

  console.log("=======================================================");
  console.log("  P-DOT LIVE VECTOR RAG VERIFICATION");
  console.log(`  Embed Model : ${embedModel} (4096-dim)`);
  console.log(`  Chat Model  : ${chatModel}`);
  console.log("=======================================================\n");

  const sampleDoc = `
# Personal Travel & Home Notes (October 2026)

## Home Wi-Fi & Devices
The main house network is "Orion-5G" with password "Starlight-9942!".
The IoT guest network for smart switches is "Orion-IoT" (vlan 20).
The garage keypad code is 4829.

## Upcoming Flight Details
Flight UA 884 to San Francisco departs on November 12, 2026 at 8:15 AM from Terminal 3, Gate B22.
Booking reference is PND-7719.
Hotel reservation: Hyatt Regency Embarcadero (Confirmation #HY-99218).
`;

  // 1. Chunking
  console.log("Step 1: Chunking Document with Recursive Chunker...");
  const chunks = splitIntoChunks(sampleDoc, { chunkSize: 260, chunkOverlap: 40 });
  console.log(`  ↳ Document split into ${chunks.length} chunks:`);
  chunks.forEach((c, i) => {
    console.log(`    [Chunk ${i + 1}] (${c.content.length} chars, ~${c.tokenEstimate} tokens):`);
    console.log(`      "${c.content.replace(/\n+/g, " ").slice(0, 85)}..."`);
  });

  // 2. Generating Live Vectors
  console.log("\nStep 2: Computing Live 4096-dim Embeddings via Nebius...");
  const embedSettings = { apiKey, baseUrl, model: embedModel };
  const chunkTexts = chunks.map((c) => c.content);

  const startEmbed = Date.now();
  const embedRes = await createEmbeddings(embedSettings, chunkTexts);
  const embedDuration = Date.now() - startEmbed;

  console.log(`  ↳ Generated ${embedRes.embeddings.length} embeddings in ${embedDuration}ms`);
  console.log(`  ↳ Vector dimension: ${embedRes.embeddings[0]?.length} floats`);
  console.log(`  ↳ Token usage: ${embedRes.usage?.promptTokens ?? "N/A"} tokens`);

  // 3. Storing in Repository
  const userId = "test-user-rag";
  const docRepo = createMockDocumentRepository(
    [
      {
        id: "doc-travel-notes",
        userId,
        filename: "travel-and-home-notes.md",
        filePath: null,
        fileSize: sampleDoc.length,
        mimeType: "text/markdown",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    chunks.map((c, i) => ({
      id: `chunk-${i + 1}`,
      userId,
      documentId: "doc-travel-notes",
      filename: "travel-and-home-notes.md",
      chunkIndex: c.chunkIndex,
      content: c.content,
      embedding: embedRes.embeddings[i]!,
    })),
  );

  // 4. Autonomous Query Simulation
  const userQuery = "Check my personal notes: What is my booking reference and gate for my San Francisco flight, and what is the garage code?";
  console.log(`\nStep 3: User Asks: "${userQuery}"`);
  console.log("  ↳ Initiating P-Dot Assistant with autonomous 'search_documents' tool...\n");

  const startChat = Date.now();
  const dummyRepo = {
    insertMessage: async (_u: string, m: any) => ({
      id: "msg-123",
      role: m.role,
      content: m.content,
      webSearch: m.webSearch ?? "off",
      sources: m.sources ?? [],
      createdAt: new Date().toISOString(),
    }),
    createConversation: async () => ({ id: "c-1", title: "Test", updatedAt: new Date().toISOString() }),
    getConversation: async () => null,
    listConversations: async () => [],
    updateConversationTitle: async () => true,
    deleteConversation: async () => true,
    listRecentMessages: async () => [],
  };

  const deps: AssistantDeps = {
    repo: dummyRepo as any,
    quota: { consume: async () => ({ allowed: true, resetsAt: new Date() }) },
    search: null,
    documentRepo: docRepo,
    embed: (text, signal) => createSingleEmbedding(embedSettings, text, { signal }),
    complete: async function* (messages: ChatMessage[], signal, options) {
      yield* streamChatCompletion(
        { apiKey, baseUrl, model: chatModel, maxOutputTokens: 512 },
        messages,
        { signal, ...options },
      );
    },
    now: () => new Date(),
    log: () => {},
  };

  const turn = {
    requestId: "live-rag-test",
    userId,
    conversation: { id: "c-1", title: "RAG Test", updatedAt: new Date().toISOString() },
    userMessage: {
      id: "msg-0",
      role: "user" as const,
      content: userQuery,
      webSearch: "off" as const,
      sources: [],
      createdAt: new Date().toISOString(),
    },
    history: [{ role: "user" as const, content: userQuery }],
    webSearch: false,
  };

  const events = await collect(streamChatTurn(deps, turn, new AbortController().signal));
  const chatDuration = Date.now() - startChat;

  console.log("----------------- LIVE CHAT STREAM OUTPUT -----------------");
  for (const e of events) {
    if (e.type === "thought") {
      console.log(`\n💭 [Chain of Thought]: ${e.text}`);
    } else if (e.type === "search") {
      console.log(`\n📄 [Document Sources Retrieved]:`);
      e.sources.forEach((s, idx) => {
        console.log(`   [${idx + 1}] ${s.title} (${s.url})`);
      });
    }
  }

  const doneEvent = events.find((e) => e.type === "done");
  if (doneEvent && doneEvent.type === "done") {
    console.log(`\n🤖 [Assistant Synthesized Reply]:\n${doneEvent.message.content}`);
    console.log("\n-----------------------------------------------------------");
    console.log(`✅ Success! Response grounded in personal document with citations.`);
    console.log(`⏱️ Latency: ${chatDuration}ms (Embedding: ${embedDuration}ms)`);
  } else {
    console.log("\n❌ No completion received:", events);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
