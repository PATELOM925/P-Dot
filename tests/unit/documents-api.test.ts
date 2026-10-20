import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/server/auth/session";
import { createMockDocumentRepository } from "@/server/db/documents";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/config", () => ({
  getAssistantConfig: vi.fn(),
  getSiteUrl: () => "http://localhost:3000",
}));
vi.mock("@/server/db/documents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db/documents")>()),
  createDocumentRepository: vi.fn(),
}));
vi.mock("@/server/providers/nebius/embeddings", () => ({
  createEmbeddings: vi.fn(async (_settings, texts: string | string[]) => {
    const list = Array.isArray(texts) ? texts : [texts];
    return {
      embeddings: list.map(() => [0.1, 0.2, 0.3]),
    };
  }),
}));

const { getAuthContext } = await import("@/server/auth/session");
const { getAssistantConfig } = await import("@/server/config");
const { createDocumentRepository } = await import("@/server/db/documents");
const documentsRoute = await import("@/app/api/documents/route");
const itemRoute = await import("@/app/api/documents/[id]/route");

const ALICE = "11111111-1111-4111-8111-111111111111";

function signInAs(userId: string | null) {
  vi.mocked(getAuthContext).mockResolvedValue(
    userId
      ? ({ userId, email: `${userId}@example.com`, supabase: {} as SupabaseClient } satisfies AuthContext)
      : null,
  );
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

let mockRepo: ReturnType<typeof createMockDocumentRepository>;

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  mockRepo = createMockDocumentRepository();
  vi.mocked(createDocumentRepository).mockReturnValue(mockRepo);
  vi.mocked(getAssistantConfig).mockReturnValue({
    nebius: {
      apiKey: "test-key",
      baseUrl: "https://api.test/v1",
      model: "test-model",
      embeddingModel: "Qwen/Qwen3-Embedding-8B",
      maxOutputTokens: 256,
    },
    tavily: null,
    quota: { requestsPerWindow: 30, windowSeconds: 3600 },
  });
});

describe("/api/documents Routes", () => {
  it("rejects unauthorized requests with 401", async () => {
    signInAs(null);
    const res = await documentsRoute.GET(new Request("http://localhost/api/documents", { headers: { host: "localhost" } }));
    expect(res.status).toBe(401);
  });

  it("lists documents for authenticated user", async () => {
    signInAs(ALICE);
    await mockRepo.createDocument(ALICE, { filename: "spec.txt", fileSize: 200 });

    const res = await documentsRoute.GET(new Request("http://localhost/api/documents", { headers: { host: "localhost" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0].filename).toBe("spec.txt");
  });

  it("ingests a document via POST /api/documents and returns 201 with chunk count", async () => {
    signInAs(ALICE);
    const req = new Request("http://localhost/api/documents", {
      method: "POST",
      headers: {
        host: "localhost",
        origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filename: "notes.md",
        content: "First section on vector architecture.\n\nSecond section on embedding generation.",
      }),
    });

    const res = await documentsRoute.POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.document.filename).toBe("notes.md");
    expect(body.chunkCount).toBeGreaterThanOrEqual(1);

    const listed = await mockRepo.listDocuments(ALICE);
    expect(listed).toHaveLength(1);
  });

  it("rejects invalid document POST requests", async () => {
    signInAs(ALICE);
    const req = new Request("http://localhost/api/documents", {
      method: "POST",
      headers: { host: "localhost", origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "", content: "" }),
    });

    const res = await documentsRoute.POST(req);
    expect(res.status).toBe(400);
  });

  it("GET /api/documents/:id returns document or 404", async () => {
    signInAs(ALICE);
    const doc = await mockRepo.createDocument(ALICE, { filename: "guide.txt", fileSize: 100 });

    // Valid ID
    const validReq = new Request(`http://localhost/api/documents/${doc.id}`, { headers: { host: "localhost" } });
    const res = await itemRoute.GET(validReq, params(doc.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filename).toBe("guide.txt");

    // Nonexistent ID (UUID format)
    const missingRes = await itemRoute.GET(
      new Request("http://localhost/api/documents/00000000-0000-4000-8000-000000000000", { headers: { host: "localhost" } }),
      params("00000000-0000-4000-8000-000000000000"),
    );
    expect(missingRes.status).toBe(404);
  });

  it("DELETE /api/documents/:id removes document and returns 204", async () => {
    signInAs(ALICE);
    const doc = await mockRepo.createDocument(ALICE, { filename: "temp.txt", fileSize: 50 });

    const delReq = new Request(`http://localhost/api/documents/${doc.id}`, {
      method: "DELETE",
      headers: { host: "localhost", origin: "http://localhost" },
    });
    const delRes = await itemRoute.DELETE(delReq, params(doc.id));
    expect(delRes.status).toBe(204);

    const check = await mockRepo.getDocument(ALICE, doc.id);
    expect(check).toBeNull();
  });
});
