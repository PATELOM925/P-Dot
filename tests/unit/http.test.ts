import { describe, expect, it } from "vitest";
import { readChatStream, StreamFormatError } from "@/features/chat/stream";
import { getAssistantConfig, getSiteUrl } from "@/server/config";
import { ConfigError } from "@/lib/supabase-config";
import { isSameOrigin, readJsonBody } from "@/server/http/request";
import { collect, streamFrom } from "../support/streams";

function post(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("readJsonBody", () => {
  it("parses JSON within the size limit", async () => {
    expect(await readJsonBody(post('{"a":1}'), 100)).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rejects bodies over the limit even without a content-length header", async () => {
    const request = new Request("http://localhost/api/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: streamFrom(['{"a":"', "x".repeat(200), '"}']),
      duplex: "half",
    } as RequestInit);
    expect(await readJsonBody(request, 100)).toMatchObject({ ok: false, status: 413 });
  });

  it("rejects other content types", async () => {
    expect(await readJsonBody(post("{}", { "content-type": "text/plain" }), 100)).toMatchObject({ status: 415 });
  });
});

describe("isSameOrigin", () => {
  const request = (headers: Record<string, string>) => new Request("http://localhost/", { headers });

  it("accepts matching or absent Origin headers", () => {
    expect(isSameOrigin(request({ host: "app.example", origin: "https://app.example" }))).toBe(true);
    expect(isSameOrigin(request({ host: "app.example" }))).toBe(true);
  });

  it("rejects other origins", () => {
    expect(isSameOrigin(request({ host: "app.example", origin: "https://evil.example" }))).toBe(false);
    expect(isSameOrigin(request({ host: "app.example", origin: "null" }))).toBe(false);
  });
});

describe("readChatStream", () => {
  it("parses events split across chunks", async () => {
    const events = await collect(
      readChatStream(streamFrom(['{"type":"delta","te', 'xt":"a"}\n\n{"type":"delta","text":"b"}\n{"type":"done"', ',"message":{},"truncated":false}'])),
    );
    expect(events.map((e) => e.type)).toEqual(["delta", "delta", "done"]);
  });

  it("rejects unknown event shapes", async () => {
    await expect(collect(readChatStream(streamFrom(['{"type":"exec"}\n'])))).rejects.toBeInstanceOf(StreamFormatError);
  });
});

describe("getAssistantConfig", () => {
  it("requires the Nebius key and model and reports names only", () => {
    try {
      getAssistantConfig({ NEBIUS_API_KEY: "", NODE_ENV: "test" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).missing).toEqual(["NEBIUS_API_KEY", "NEBIUS_MODEL"]);
    }
  });

  it("applies defaults and treats a blank Tavily key as search disabled", () => {
    const config = getAssistantConfig({
      NEBIUS_API_KEY: "secret",
      NEBIUS_MODEL: "org/model",
      NEBIUS_BASE_URL: "https://api.tokenfactory.nebius.com/v1/",
      TAVILY_API_KEY: " ",
      NODE_ENV: "test",
    });
    expect(config.nebius).toEqual({
      apiKey: "secret",
      baseUrl: "https://api.tokenfactory.nebius.com/v1",
      model: "org/model",
      maxOutputTokens: 1024,
    });
    expect(config.tavily).toBeNull();
    expect(config.quota).toEqual({ requestsPerWindow: 30, windowSeconds: 3600 });
  });

  it("rejects out-of-range limits", () => {
    expect(() =>
      getAssistantConfig({ NEBIUS_API_KEY: "k", NEBIUS_MODEL: "m", CHAT_WINDOW_SECONDS: "5", NODE_ENV: "test" }),
    ).toThrow(ConfigError);
  });
});

describe("getSiteUrl", () => {
  it("uses SITE_URL without a trailing slash, else localhost", () => {
    expect(getSiteUrl({ SITE_URL: "https://p-dot.example/", NODE_ENV: "test" })).toBe("https://p-dot.example");
    expect(getSiteUrl({ NODE_ENV: "test" })).toBe("http://localhost:3000");
  });
});
