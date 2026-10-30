#!/usr/bin/env node
// Local stand-ins for Nebius Token Factory and Tavily, for trying P-Dot without
// API keys or spending money. NOT a real model: replies come from simple rules and
// are labelled "Simulated reply". It speaks the same wire format the app uses:
//
//   POST /v1/chat/completions   streamed chat completions, with tool calls
//   POST /v1/embeddings         deterministic 1,024-number vectors
//   GET  /v1/models             the model names P-Dot routes to
//   POST /tavily/search         Tavily search results (clearly fake pages)
//   POST /tavily/extract        Tavily page text for deep research (clearly fake)
//
// Run:  npm run mock:providers        (listens on http://127.0.0.1:4010)
// Point the app at it with the values in .env.example ("Local simulation").

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 4010;
const EMBEDDING_DIMENSIONS = 1024;
const MODELS = [
  "nvidia/Nemotron-3_5-Lightning",
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/Nemotron-3-Ultra-550b-a55b",
  "nvidia/Nemotron-3.5-Super-VL",
  "Qwen/Qwen3-Embedding-8B",
];

const SIMULATED = "Simulated reply (local mock model, not a real LLM).";

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ");
  return "";
}

/** The user's own words: the part inside <user_message>, or the whole message. */
function userWords(content) {
  const text = textOf(content);
  const wrapped = /<user_message>\s*([\s\S]*?)\s*<\/user_message>/.exec(text);
  return (wrapped ? wrapped[1] : text).trim();
}

/** Sources from a <web_search_results> block, as [{ n, title, url }]. */
function sourcesIn(text) {
  const sources = [];
  const pattern = /<source id="(\d+)">\s*Title: (.*)\s*URL: (.*)/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    sources.push({ n: Number(match[1]), title: match[2].trim(), url: match[3].trim() });
  }
  return sources;
}

function tomorrowNineUtc() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCHours(9, 0, 0, 0);
  return date.toISOString();
}

/** What the simulated model does for one request: text to say, or tool calls to make. */
export function plan(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = new Set((body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean));
  const system = textOf(messages.find((message) => message.role === "system")?.content);
  const last = messages.at(-1);

  if (last?.role === "tool") {
    const result = textOf(last.content);
    const sources = sourcesIn(result);
    if (sources.length > 0) {
      return { text: `${SIMULATED} From the extra search: ${sources.map((s) => `${s.title} [${s.n}]`).join("; ")}.` };
    }
    if (/card now asks/i.test(result)) {
      return { text: `${SIMULATED} I put a card below. Approve it when you are ready; nothing happens until you do.` };
    }
    return { text: `${SIMULATED} I used that tool and have nothing more to add.` };
  }

  const lastUserContent = [...messages].reverse().find((message) => message.role === "user")?.content;
  const fullText = textOf(lastUserContent);
  const words = userWords(lastUserContent);
  const work = /Work mode/.test(system);

  if (work && /\b(dinner|recipe|gift|birthday|grocer(y|ies)|family|mum|mom)\b/i.test(words)) {
    return { text: `${SIMULATED} That sounds personal, so it belongs in Personal mode. I can help with a work topic here instead.` };
  }
  if (!work && /\b(stand-?up|deadline|pull request|sprint|quarterly|standup)\b/i.test(words)) {
    return { text: `${SIMULATED} That sounds like work, so it belongs in Work mode. I can help with a personal topic here instead.` };
  }

  const remind = /remind me (?:to |about )?(.+?)(?:\s+(?:tomorrow|on|at|in|next)\b.*)?$/i.exec(words);
  if (tools.has("propose_reminder") && remind) {
    return { calls: [{ name: "propose_reminder", args: { title: remind[1].trim().slice(0, 120), dueAt: tomorrowNineUtc() } }] };
  }
  const remember = /remember (?:that )?(.+)/i.exec(words);
  if (tools.has("save_memory") && remember) {
    return { calls: [{ name: "save_memory", args: { content: remember[1].trim().slice(0, 300) } }] };
  }
  const task = /(?:add|create)\s+(?:a\s+)?(?:task|to-?do)(?:\s+(?:to|for|called|:))?\s*(.+)/i.exec(words);
  if (tools.has("propose_task") && task) {
    return { calls: [{ name: "propose_task", args: { title: task[1].trim().slice(0, 150) } }] };
  }

  const sources = sourcesIn(fullText);
  if (sources.length > 0) {
    const cites = sources.map((source) => `${source.title} [${source.n}]`).join("; ");
    return { text: `${SIMULATED} Using the web results attached to your message, here is a short answer to "${words.slice(0, 120)}". The sources say: ${cites}.` };
  }
  return {
    text: `${SIMULATED} You asked: "${words.slice(0, 200)}". A real model would answer here. This local mock only checks that chat, streaming, history and the approval cards work end to end.`,
  };
}

function sse(res, payload) {
  res.write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function streamChat(req, res, body) {
  const id = `chatcmpl-mock-${Date.now().toString(36)}`;
  const model = typeof body.model === "string" ? body.model : MODELS[0];
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

  const decided = plan(body);
  const promptTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
  let completionTokens = 0;
  let finish = "stop";

  if (decided.calls) {
    finish = "tool_calls";
    for (const [index, call] of decided.calls.entries()) {
      const args = JSON.stringify(call.args);
      sse(res, {
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index, id: `call_mock_${index}`, type: "function", function: { name: call.name, arguments: args } }] },
            finish_reason: null,
          },
        ],
      });
      completionTokens += Math.ceil(args.length / 4);
    }
  } else {
    for (const piece of decided.text.split(/(?<=\s)/)) {
      if (closed) return res.end();
      sse(res, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      completionTokens += 1;
      await sleep(18);
    }
  }

  sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  sse(res, {
    ...base,
    choices: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  });
  sse(res, "[DONE]");
  res.end();
}

/** A stable vector for a text: the same words always give the same numbers, of length 1. */
export function embed(text, dimensions = EMBEDDING_DIMENSIONS) {
  const vector = new Array(dimensions).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let hash = 2166136261;
    for (const char of word) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
    vector[hash % dimensions] += 1;
    vector[(hash >>> 11) % dimensions] -= 0.5;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function tavilyResults(query) {
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "search";
  return [1, 2, 3].map((n) => ({
    title: `Simulated result ${n} for "${query.slice(0, 60)}"`,
    url: `https://example.com/simulated/${slug}-${n}`,
    content: `Simulated web page ${n} written by the local mock, not a real page. It exists to test that P-Dot sends a search, shows source chips and cites them. Query: ${query.slice(0, 120)}.`,
    score: Number((0.9 - n * 0.1).toFixed(2)),
  }));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

export function createMockServer({ log = () => {} } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok", mock: true });
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return json(res, 200, { object: "list", data: MODELS.map((id) => ({ id, object: "model", owned_by: "mock" })) });
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        if (!req.headers.authorization?.startsWith("Bearer ")) return json(res, 401, { error: { message: "Missing key", code: "401" } });
        const body = await readJson(req);
        log(`chat ${body.model} tools=${(body.tools ?? []).length} messages=${(body.messages ?? []).length}`);
        return await streamChat(req, res, body);
      }
      if (req.method === "POST" && url.pathname === "/v1/embeddings") {
        const body = await readJson(req);
        const inputs = Array.isArray(body.input) ? body.input : [String(body.input ?? "")];
        const dimensions = Number.isInteger(body.dimensions) ? body.dimensions : EMBEDDING_DIMENSIONS;
        log(`embeddings x${inputs.length}`);
        return json(res, 200, {
          object: "list",
          model: body.model ?? "Qwen/Qwen3-Embedding-8B",
          data: inputs.map((input, index) => ({ object: "embedding", index, embedding: embed(String(input), dimensions) })),
          usage: { prompt_tokens: inputs.join(" ").length, total_tokens: inputs.join(" ").length },
        });
      }
      if (req.method === "POST" && url.pathname === "/tavily/search") {
        if (!req.headers.authorization?.startsWith("Bearer ")) return json(res, 401, { detail: "Missing key" });
        const body = await readJson(req);
        const query = typeof body.query === "string" ? body.query : "";
        log(`tavily search "${query.slice(0, 60)}"`);
        const max = Math.min(Number(body.max_results) || 5, 3);
        return json(res, 200, { query, results: tavilyResults(query).slice(0, max), response_time: 0.01 });
      }
      if (req.method === "POST" && url.pathname === "/tavily/extract") {
        if (!req.headers.authorization?.startsWith("Bearer ")) return json(res, 401, { detail: "Missing key" });
        const body = await readJson(req);
        const urls = (Array.isArray(body.urls) ? body.urls : []).filter((value) => typeof value === "string");
        log(`tavily extract x${urls.length}`);
        return json(res, 200, {
          results: urls.map((pageUrl) => ({
            url: pageUrl,
            raw_content: `Simulated page text written by the local mock, not a real page. It exists to test that deep research reads whole pages and cites them. URL: ${pageUrl}.`,
          })),
          failed_results: [],
          response_time: 0.01,
        });
      }
      return json(res, 404, { error: { message: "Not found" } });
    } catch (error) {
      log(`error ${error instanceof Error ? error.message : "unknown"}`);
      if (!res.headersSent) return json(res, 400, { error: { message: "Bad request" } });
      res.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_PORT) || DEFAULT_PORT;
  createMockServer({ log: (line) => console.log(`[mock] ${line}`) }).listen(port, "127.0.0.1", () => {
    console.log(`[mock] Simulated Nebius and Tavily on http://127.0.0.1:${port}`);
    console.log(`[mock]   NEBIUS_BASE_URL=http://127.0.0.1:${port}/v1`);
    console.log(`[mock]   TAVILY_BASE_URL=http://127.0.0.1:${port}/tavily`);
  });
}
