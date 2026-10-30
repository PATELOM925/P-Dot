import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error The mock is a plain .mjs script with no type declarations.
import { createMockServer, embed, plan } from "../../scripts/mock-providers.mjs";
import { streamChatCompletion } from "@/server/providers/nebius/client";
import { createEmbeddings } from "@/server/providers/nebius/embeddings";
import { extractPages, searchWeb } from "@/server/providers/tavily/client";
import { getAssistantConfig } from "@/server/config";
import { collect } from "../support/streams";

let server: ReturnType<typeof createMockServer>;
let origin = "";

beforeAll(async () => {
  server = createMockServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const settings = () => ({ apiKey: "local-mock-key", baseUrl: `${origin}/v1`, model: "nvidia/Nemotron-3_5-Lightning", maxOutputTokens: 256 });

describe("mock providers speak the formats P-Dot's real clients parse", () => {
  it("streams a labelled text reply through the real Nebius client", async () => {
    const chunks = await collect(streamChatCompletion(settings(), [{ role: "user", content: "Hello there" }]));
    const text = chunks.flatMap((chunk) => (chunk.type === "text" ? [chunk.text] : [])).join("");
    expect(text).toContain("Simulated reply");
    expect(text).toContain("Hello there");
    const finish = chunks.at(-1);
    expect(finish).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  it("makes a reminder tool call only when the tool is offered", async () => {
    const tool = {
      name: "propose_reminder",
      description: "Propose a reminder",
      parameters: { type: "object", properties: { title: { type: "string" }, dueAt: { type: "string" } } },
    };
    const withTool = await collect(
      streamChatCompletion(settings(), [{ role: "user", content: "Remind me to call the dentist tomorrow at 10 am" }], { tools: [tool] }),
    );
    const calls = withTool.find((chunk) => chunk.type === "tool_calls");
    expect(calls).toBeDefined();
    if (calls?.type === "tool_calls") {
      expect(calls.calls[0]!.name).toBe("propose_reminder");
      expect(JSON.parse(calls.calls[0]!.arguments)).toMatchObject({ title: "call the dentist" });
    }

    const without = await collect(streamChatCompletion(settings(), [{ role: "user", content: "Remind me to call the dentist" }]));
    expect(without.some((chunk) => chunk.type === "tool_calls")).toBe(false);
  });

  it("rejects a request with no key like the real API", async () => {
    const response = await fetch(`${origin}/v1/chat/completions`, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
  });

  it("returns 1,024-number vectors of length 1 that the embeddings client accepts", async () => {
    const result = await createEmbeddings({ apiKey: "k", baseUrl: `${origin}/v1` }, ["likes short answers", "likes tea"]);
    expect(result.vectors).toHaveLength(2);
    for (const vector of result.vectors) {
      expect(vector).toHaveLength(1024);
      expect(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 5);
    }
    expect(embed("same words")).toEqual(embed("same words"));
  });

  it("serves Tavily results that the real search client turns into safe sources", async () => {
    const results = await searchWeb({ apiKey: "k", baseUrl: `${origin}/tavily` }, "top news today");
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.url).toMatch(/^https:\/\/example\.com\/simulated\//);
      expect(result.excerpt).toContain("Simulated");
    }
  });

  it("serves Tavily page text that the real extract client keeps for deep research", async () => {
    const asked = ["https://example.com/simulated/a-1", "https://example.com/simulated/a-2"];
    const pages = await extractPages({ apiKey: "k", baseUrl: `${origin}/tavily` }, asked);
    expect(pages.map((page) => page.url)).toEqual(asked);
    for (const page of pages) expect(page.text).toContain("Simulated page text");
  });
});

describe("plan (the simulated model's rules)", () => {
  it("cites attached web results", () => {
    const content = '<user_message>\nlatest news\n</user_message>\n\n<web_search_results>\n<source id="1">\nTitle: Example headline\nURL: https://example.com/a\nExcerpt: x\n</source>\n</web_search_results>';
    expect(plan({ messages: [{ role: "user", content }] }).text).toMatch(/Example headline \[1\]/);
  });

  it("keeps Work and Personal topics apart, like the app's scope instruction", () => {
    const work = plan({ messages: [{ role: "system", content: "This conversation is in Work mode." }, { role: "user", content: "Plan dinner for my family" }] });
    expect(work.text).toContain("Personal mode");
    const personal = plan({ messages: [{ role: "system", content: "This conversation is in Personal mode." }, { role: "user", content: "Prepare my standup" }] });
    expect(personal.text).toContain("Work mode");
  });
});

describe("TAVILY_BASE_URL", () => {
  const base = { NEBIUS_API_KEY: "k", TAVILY_API_KEY: "t", NODE_ENV: "test" } as NodeJS.ProcessEnv;

  it("is optional and trimmed when set to this machine", () => {
    expect(getAssistantConfig(base).tavily).toEqual({ apiKey: "t" });
    expect(getAssistantConfig({ ...base, TAVILY_BASE_URL: "http://127.0.0.1:4010/tavily/" }).tavily).toEqual({
      apiKey: "t",
      baseUrl: "http://127.0.0.1:4010/tavily",
    });
    expect(getAssistantConfig({ ...base, TAVILY_BASE_URL: "https://proxy.example.com" }).tavily?.baseUrl).toBe("https://proxy.example.com");
  });

  it("refuses a plain-http address that is not this machine, so the key cannot leave in the clear", () => {
    expect(() => getAssistantConfig({ ...base, TAVILY_BASE_URL: "http://tavily.example.com" })).toThrow();
  });
});
