import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_DOCUMENT_BODY_BYTES, MAX_DOCUMENT_CHARS } from "@/lib/limits";
import { ConfigError } from "@/lib/supabase-config";
import type { AuthContext } from "@/server/auth/session";
import type { AssistantConfig } from "@/server/config";
import { EmbeddingBudgetError, type Embedder } from "@/server/assistant/embed";
import { NebiusHoldTooLargeError } from "@/server/assistant/spend";
import type { DocumentRepository, NewChunk, NewDocument } from "@/server/db/documents";
import { ProviderError } from "@/server/providers/errors";
import type { DocumentDTO, DocumentStatus, Mode } from "@/types/api";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/config", () => ({ getAssistantConfig: vi.fn() }));
vi.mock("@/server/assistant/deps", () => ({ createEmbedderForRequest: vi.fn() }));
vi.mock("@/server/db/documents", () => ({ createDocumentRepository: vi.fn() }));
vi.mock("@/server/db/action-log", () => ({ createActionLogRepository: vi.fn() }));

const { getAuthContext } = await import("@/server/auth/session");
const { getAssistantConfig } = await import("@/server/config");
const { createEmbedderForRequest } = await import("@/server/assistant/deps");
const { createDocumentRepository } = await import("@/server/db/documents");
const { createActionLogRepository } = await import("@/server/db/action-log");
const documentsRoute = await import("@/app/api/documents/route");
const documentItemRoute = await import("@/app/api/documents/[id]/route");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET = "Quarterly plan SECRET-MARKER-42.";
const FAILED_MESSAGE = "The document could not be processed. Please retry.";

// ---------------------------------------------------------------------------
// Fakes. They keep state in memory and record what the routes did.
// ---------------------------------------------------------------------------

interface StoredDocument {
  dto: DocumentDTO;
  userId: string;
  chunks: NewChunk[];
}

class FakeDocuments implements DocumentRepository {
  stored: StoredDocument[] = [];
  /** When set, insertChunks throws this error (a failure that is not a provider error). */
  failInsertChunks: Error | null = null;

  private find(userId: string, documentId: string) {
    return this.stored.find((d) => d.userId === userId && d.dto.id === documentId);
  }

  async listDocuments(userId: string, mode: Mode, limit: number): Promise<DocumentDTO[]> {
    return this.stored
      .filter((d) => d.userId === userId && d.dto.mode === mode)
      .map((d) => ({ ...d.dto }))
      .reverse()
      .slice(0, limit);
  }

  async createDocument(userId: string, doc: NewDocument): Promise<DocumentDTO> {
    const dto: DocumentDTO = {
      id: crypto.randomUUID(),
      mode: doc.mode,
      title: doc.title,
      mediaType: doc.mediaType,
      charCount: doc.charCount,
      status: "processing",
      createdAt: new Date().toISOString(),
    };
    this.stored.push({ dto, userId, chunks: [] });
    return { ...dto };
  }

  async insertChunks(userId: string, documentId: string, chunks: NewChunk[]): Promise<void> {
    if (this.failInsertChunks) throw this.failInsertChunks;
    const doc = this.find(userId, documentId);
    if (!doc) throw new Error("document not found in fake");
    doc.chunks.push(...chunks);
  }

  async setStatus(userId: string, documentId: string, status: DocumentStatus): Promise<void> {
    const doc = this.find(userId, documentId);
    if (doc) doc.dto.status = status;
  }

  /** Same rules as the real repository: chunks with embeddings make it ready, otherwise failed. */
  async settleStaleDocuments(userId: string, createdBefore: Date, limit: number): Promise<number> {
    const stale = this.stored
      .filter((d) => d.userId === userId && d.dto.status === "processing")
      .filter((d) => new Date(d.dto.createdAt) < createdBefore)
      .slice(0, limit);
    for (const doc of stale) {
      const complete = doc.chunks.length > 0 && doc.chunks.every((c) => c.embedding.length > 0);
      doc.dto.status = complete ? "ready" : "failed";
    }
    return stale.length;
  }

  async deleteDocument(userId: string, documentId: string): Promise<boolean> {
    const index = this.stored.findIndex((d) => d.userId === userId && d.dto.id === documentId);
    if (index < 0) return false;
    this.stored.splice(index, 1);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signInAs(userId: string | null) {
  vi.mocked(getAuthContext).mockResolvedValue(
    userId ? ({ userId, email: `${userId}@example.com`, supabase: {} as SupabaseClient } satisfies AuthContext) : null,
  );
}

function jsonRequest(method: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/documents", {
    method,
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function rawRequest(method: string, body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/documents", {
    method,
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body,
  });
}

function plainRequest(method: string, url = "http://localhost/api/documents", headers: Record<string, string> = {}) {
  return new Request(url, { method, headers: { host: "localhost", origin: "http://localhost", ...headers } });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Several paragraphs, with a marker that must never appear in a log. */
const LONG_TEXT = `${SECRET}\n\n${"Filler sentence for the plan. ".repeat(200)}`;

function validBody(overrides: Record<string, unknown> = {}) {
  return { mode: "work", title: "Team handbook", mediaType: "text/plain", text: LONG_TEXT, ...overrides };
}

/** Everything the code logged, as one string. */
interface CallRecorder {
  mock: { calls: unknown[][] };
}

function allLogText(spies: CallRecorder[]): string {
  return spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call))).join("\n");
}

let docs: FakeDocuments;
let embedder: { embed: ReturnType<typeof vi.fn> };
let consoleSpies: CallRecorder[];

beforeEach(() => {
  consoleSpies = [
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  ];
  docs = new FakeDocuments();
  embedder = { embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])) };
  vi.mocked(createDocumentRepository).mockReturnValue(docs);
  vi.mocked(createActionLogRepository).mockClear();
  vi.mocked(getAssistantConfig).mockReturnValue({} as AssistantConfig);
  vi.mocked(createEmbedderForRequest).mockReturnValue(embedder as unknown as Embedder);
});

// ---------------------------------------------------------------------------
// GET /api/documents
// ---------------------------------------------------------------------------

describe("GET /api/documents", () => {
  it("requires a session", async () => {
    signInAs(null);
    expect((await documentsRoute.GET(plainRequest("GET", "http://localhost/api/documents?mode=work"))).status).toBe(401);
  });

  it("rejects a missing or unknown mode", async () => {
    signInAs(ALICE);
    expect((await documentsRoute.GET(plainRequest("GET", "http://localhost/api/documents"))).status).toBe(400);
    expect((await documentsRoute.GET(plainRequest("GET", "http://localhost/api/documents?mode=hobby"))).status).toBe(400);
  });

  it("lists only the signed-in user's documents in the requested mode, without embeddings", async () => {
    signInAs(ALICE);
    await docs.createDocument(ALICE, { mode: "work", title: "Mine", mediaType: "text/plain", charCount: 10 });
    await docs.createDocument(ALICE, { mode: "personal", title: "Home", mediaType: "text/plain", charCount: 10 });
    await docs.createDocument(BOB, { mode: "work", title: "Bob's", mediaType: "text/plain", charCount: 10 });

    const response = await documentsRoute.GET(plainRequest("GET", "http://localhost/api/documents?mode=work"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.documents.map((d: DocumentDTO) => d.title)).toEqual(["Mine"]);
    expect(JSON.stringify(body)).not.toContain("embedding");
  });
});

// ---------------------------------------------------------------------------
// POST /api/documents
// ---------------------------------------------------------------------------

describe("POST /api/documents", () => {
  it("requires a session and creates nothing", async () => {
    signInAs(null);
    expect((await documentsRoute.POST(jsonRequest("POST", validBody()))).status).toBe(401);
    expect(docs.stored).toHaveLength(0);
  });

  it("rejects a cross-origin upload", async () => {
    signInAs(ALICE);
    const response = await documentsRoute.POST(jsonRequest("POST", validBody(), { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(docs.stored).toHaveLength(0);
  });

  it.each([
    ["an empty text", { text: "" }],
    ["a text of only spaces", { text: "  \n  " }],
    ["a text over the limit", { text: "a".repeat(MAX_DOCUMENT_CHARS + 1) }],
    ["an unknown media type", { mediaType: "text/html" }],
    ["an empty title", { title: "   " }],
    ["a title that is too long", { title: "x".repeat(201) }],
    ["an unknown mode", { mode: "hobby" }],
    ["a client-supplied user", { userId: BOB }],
  ])("rejects %s with 400 and creates nothing", async (_label, override) => {
    signInAs(ALICE);
    const response = await documentsRoute.POST(jsonRequest("POST", validBody(override)));
    expect(response.status).toBe(400);
    expect(docs.stored).toHaveLength(0);
  });

  it("rejects a body that is not JSON, and a body that is not application/json", async () => {
    signInAs(ALICE);
    expect((await documentsRoute.POST(rawRequest("POST", "{not json"))).status).toBe(400);
    const notJson = new Request("http://localhost/api/documents", {
      method: "POST",
      headers: { host: "localhost", origin: "http://localhost", "content-type": "text/plain" },
      body: "hello",
    });
    expect((await documentsRoute.POST(notJson)).status).toBe(415);
  });

  it("rejects a body over the size limit with 413", async () => {
    signInAs(ALICE);
    const big = JSON.stringify(validBody({ text: "a".repeat(MAX_DOCUMENT_BODY_BYTES) }));
    expect((await documentsRoute.POST(rawRequest("POST", big))).status).toBe(413);
    expect(docs.stored).toHaveLength(0);
  });

  it("answers a configuration error before any document is created", async () => {
    signInAs(ALICE);
    vi.mocked(getAssistantConfig).mockImplementation(() => {
      throw new ConfigError(["NEBIUS_API_KEY"]);
    });
    const response = await documentsRoute.POST(jsonRequest("POST", validBody()));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("not_configured");
    expect(docs.stored).toHaveLength(0);
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it("stores ready chunks with their embeddings and answers 201 without embeddings", async () => {
    signInAs(ALICE);
    const response = await documentsRoute.POST(jsonRequest("POST", validBody()));
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body).toMatchObject({ mode: "work", title: "Team handbook", mediaType: "text/plain", status: "ready" });
    expect(body.charCount).toBe(LONG_TEXT.length);
    expect(JSON.stringify(body)).not.toContain("embedding");

    const stored = docs.stored[0]!;
    expect(stored.dto.status).toBe("ready");
    expect(stored.chunks.length).toBeGreaterThan(1);
    expect(stored.chunks.map((c) => c.index)).toEqual(stored.chunks.map((_, i) => i));
    expect(stored.chunks[0]!.content).toContain("SECRET-MARKER-42");

    // The database writes the action log rows (document_added, then document_ready) from triggers.
    expect(createActionLogRepository).not.toHaveBeenCalled();
  });

  it("keeps the document text out of the server logs", async () => {
    signInAs(ALICE);
    await documentsRoute.POST(jsonRequest("POST", validBody()));
    expect(allLogText(consoleSpies)).not.toContain("SECRET-MARKER");
  });

  it("marks the document failed and answers 429 when the daily budget refuses", async () => {
    signInAs(ALICE);
    embedder.embed.mockRejectedValueOnce(new EmbeddingBudgetError("day"));

    const response = await documentsRoute.POST(jsonRequest("POST", validBody()));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await response.json()).toMatchObject({ error: { code: "budget_exhausted" } });

    expect(docs.stored[0]!.dto.status).toBe("failed");
    expect(docs.stored[0]!.chunks).toHaveLength(0);
    expect(allLogText(consoleSpies)).not.toContain("SECRET-MARKER");
  });

  it("answers 429 for a user's own daily limit", async () => {
    signInAs(ALICE);
    embedder.embed.mockRejectedValueOnce(new EmbeddingBudgetError("user"));
    const response = await documentsRoute.POST(jsonRequest("POST", validBody()));
    expect(response.status).toBe(429);
    expect((await response.json()).error.message).toBe("You have reached your daily usage limit. Try again tomorrow.");
  });

  it("marks the document failed and answers 413 when a batch is too large for one spend hold", async () => {
    signInAs(ALICE);
    embedder.embed.mockRejectedValueOnce(new NebiusHoldTooLargeError());
    const response = await documentsRoute.POST(jsonRequest("POST", validBody()));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "payload_too_large" } });
    expect(docs.stored[0]!.dto.status).toBe("failed");
    expect(docs.stored[0]!.chunks).toHaveLength(0);
  });

  it("marks the document failed and answers 502 when the provider fails", async () => {
    signInAs(ALICE);
    embedder.embed.mockRejectedValueOnce(new ProviderError("nebius", "unavailable", 500));

    const response = await documentsRoute.POST(jsonRequest("POST", validBody()));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "provider_unavailable", message: FAILED_MESSAGE },
    });
    expect(docs.stored[0]!.dto.status).toBe("failed");
    expect(docs.stored[0]!.chunks).toHaveLength(0);
  });

  it("marks the document failed and answers 500 for any other error", async () => {
    signInAs(ALICE);
    docs.failInsertChunks = new Error("database detail with SECRET-MARKER-42");

    const response = await documentsRoute.POST(jsonRequest("POST", validBody()));
    expect(response.status).toBe(500);
    expect(docs.stored[0]!.dto.status).toBe("failed");
    expect(allLogText(consoleSpies)).not.toContain("SECRET-MARKER");
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/documents/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/documents/:id", () => {
  it("requires a session", async () => {
    signInAs(null);
    expect((await documentItemRoute.DELETE(plainRequest("DELETE"), params(MISSING_ID))).status).toBe(401);
  });

  it("removes the owner's document and answers 204", async () => {
    signInAs(ALICE);
    const created = await docs.createDocument(ALICE, { mode: "work", title: "Mine", mediaType: "text/plain", charCount: 5 });

    const response = await documentItemRoute.DELETE(plainRequest("DELETE"), params(created.id));
    expect(response.status).toBe(204);
    expect(docs.stored).toHaveLength(0);
    expect(createActionLogRepository).not.toHaveBeenCalled();
  });

  it("answers 404 for another user's document, a missing one, or a bad ID, and deletes nothing", async () => {
    const theirs = await docs.createDocument(ALICE, { mode: "work", title: "Alice's", mediaType: "text/plain", charCount: 5 });
    signInAs(BOB);

    for (const id of [theirs.id, MISSING_ID, "not-a-uuid"]) {
      const response = await documentItemRoute.DELETE(plainRequest("DELETE"), params(id));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found", message: "Document not found." } });
    }
    expect(docs.stored).toHaveLength(1);
  });

  it("rejects a cross-origin delete", async () => {
    const created = await docs.createDocument(ALICE, { mode: "work", title: "Mine", mediaType: "text/plain", charCount: 5 });
    signInAs(ALICE);
    const response = await documentItemRoute.DELETE(
      plainRequest("DELETE", undefined, { origin: "https://evil.example" }),
      params(created.id),
    );
    expect(response.status).toBe(403);
    expect(docs.stored).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Recovery of documents left "processing"
// ---------------------------------------------------------------------------

describe("documents left processing", () => {
  const ELEVEN_MINUTES_MS = 11 * 60 * 1000;
  const listWork = () => documentsRoute.GET(plainRequest("GET", "http://localhost/api/documents?mode=work"));
  const makeOld = (doc: StoredDocument) => {
    doc.dto.createdAt = new Date(Date.now() - ELEVEN_MINUTES_MS).toISOString();
  };

  it("logs a failed fallback write, then a later list settles the row as ready with no embedding call", async () => {
    signInAs(ALICE);
    const setStatus = vi.spyOn(docs, "setStatus").mockRejectedValue(new Error("database unavailable"));

    const response = await documentsRoute.POST(jsonRequest("POST", validBody()));
    expect(response.status).toBe(500);
    const stored = docs.stored[0]!;
    expect(stored.chunks.length).toBeGreaterThan(1);
    expect(stored.dto.status).toBe("processing");

    const warnings = vi.mocked(console.warn).mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(warnings).toContainEqual(
      expect.objectContaining({ event: "document_status_write_failed", documentId: stored.dto.id }),
    );
    expect(allLogText(consoleSpies)).not.toContain("SECRET-MARKER");
    expect(allLogText(consoleSpies)).not.toContain("Team handbook");

    // The database is back and the upload is now stale.
    setStatus.mockRestore();
    makeOld(stored);
    const embedCalls = embedder.embed.mock.calls.length;

    const list = await listWork();
    expect(list.status).toBe(200);
    expect((await list.json()).documents[0]).toMatchObject({ id: stored.dto.id, status: "ready" });
    expect(stored.dto.status).toBe("ready");
    expect(embedder.embed.mock.calls.length).toBe(embedCalls);
  });

  it("leaves a fresh processing document alone", async () => {
    signInAs(ALICE);
    const fresh = await docs.createDocument(ALICE, { mode: "work", title: "Uploading", mediaType: "text/plain", charCount: 5 });

    const list = await listWork();
    expect((await list.json()).documents[0]).toMatchObject({ id: fresh.id, status: "processing" });
    expect(docs.stored[0]!.dto.status).toBe("processing");
  });

  it("marks a stale processing document without chunks as failed", async () => {
    signInAs(ALICE);
    const created = await docs.createDocument(ALICE, { mode: "work", title: "Stopped", mediaType: "text/plain", charCount: 5 });
    makeOld(docs.stored[0]!);

    const list = await listWork();
    expect((await list.json()).documents[0]).toMatchObject({ id: created.id, status: "failed" });
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it("does not settle another user's stale document", async () => {
    await docs.createDocument(BOB, { mode: "work", title: "Bob's", mediaType: "text/plain", charCount: 5 });
    makeOld(docs.stored[0]!);
    signInAs(ALICE);

    expect((await listWork()).status).toBe(200);
    expect(docs.stored[0]!.dto.status).toBe("processing");
  });

  it("still lists the documents when settling fails, and logs a warning", async () => {
    signInAs(ALICE);
    await docs.createDocument(ALICE, { mode: "work", title: "Mine", mediaType: "text/plain", charCount: 5 });
    vi.spyOn(docs, "settleStaleDocuments").mockRejectedValue(new Error("database unavailable"));

    const list = await listWork();
    expect(list.status).toBe(200);
    expect((await list.json()).documents).toHaveLength(1);
    const events = vi.mocked(console.warn).mock.calls.map((call) => JSON.parse(String(call[0])).event);
    expect(events).toContain("documents_settle_failed");
  });
});
