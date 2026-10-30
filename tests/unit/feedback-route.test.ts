import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/server/auth/session";
import type { FeedbackRepository, NewFeedback } from "@/server/db/feedback";
import { FEEDBACK_DAILY_LIMIT, MAX_FEEDBACK_TEXT_CHARS } from "@/lib/limits";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/db/feedback", () => ({ createFeedbackRepository: vi.fn() }));

const { getAuthContext } = await import("@/server/auth/session");
const { createFeedbackRepository } = await import("@/server/db/feedback");
const route = await import("@/app/api/feedback/route");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** A distinct text, so a test can find it if it ever reaches a log. */
const SECRET_TEXT = "Connect my Acme Corp payroll inbox";

function signInAs(userId: string | null, isAnonymous = false) {
  vi.mocked(getAuthContext).mockResolvedValue(
    userId ? ({ userId, email: null, isAnonymous, supabase: {} as SupabaseClient } as unknown as AuthContext) : null,
  );
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/feedback", {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Keeps sent rows and applies the daily cap, as the database trigger does. */
class MemoryFeedback implements FeedbackRepository {
  rows: NewFeedback[] = [];
  async send(feedback: NewFeedback) {
    if (this.rows.length >= FEEDBACK_DAILY_LIMIT) return "rate_limited" as const;
    this.rows.push(feedback);
    return "sent" as const;
  }
}

let store: MemoryFeedback;
let logs: string[];

beforeEach(() => {
  store = new MemoryFeedback();
  vi.mocked(createFeedbackRepository).mockReturnValue(store);
  logs = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});

describe("POST /api/feedback", () => {
  it("refuses a request without a session", async () => {
    signInAs(null);
    const response = await route.POST(post({ kind: "slack" }));
    expect(response.status).toBe(401);
    expect(store.rows).toEqual([]);
  });

  it("refuses a request from another origin", async () => {
    signInAs(ALICE);
    const response = await route.POST(post({ kind: "slack" }, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(store.rows).toEqual([]);
  });

  it("stores a suggestion with no text, and a trimmed note", async () => {
    signInAs(ALICE);
    expect((await route.POST(post({ kind: "slack" }))).status).toBe(201);
    expect((await route.POST(post({ kind: "drive", text: "   " }))).status).toBe(201);
    expect((await route.POST(post({ kind: "outlook", text: `  ${SECRET_TEXT}  ` }))).status).toBe(201);
    expect(store.rows).toEqual([
      { kind: "slack", text: null },
      { kind: "drive", text: null },
      { kind: "outlook", text: SECRET_TEXT },
    ]);
  });

  it("lets a trial session send a request", async () => {
    signInAs(ALICE, true);
    expect((await route.POST(post({ kind: "whatsapp" }))).status).toBe(201);
  });

  it(`accepts ${MAX_FEEDBACK_TEXT_CHARS} characters and refuses one more`, async () => {
    signInAs(ALICE);
    expect((await route.POST(post({ kind: "other", text: "x".repeat(MAX_FEEDBACK_TEXT_CHARS) }))).status).toBe(201);
    const response = await route.POST(post({ kind: "other", text: "x".repeat(MAX_FEEDBACK_TEXT_CHARS + 1) }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(`Keep the note to ${MAX_FEEDBACK_TEXT_CHARS} characters or fewer.`);
    expect(store.rows).toHaveLength(1);
  });

  it("refuses Other without text, an unknown kind, extra fields and a body that is not JSON", async () => {
    signInAs(ALICE);
    const other = await route.POST(post({ kind: "other", text: "  " }));
    expect(other.status).toBe(400);
    expect((await other.json()).error.message).toBe("Type what P-Dot should connect to.");
    expect((await route.POST(post({ kind: "myspace" }))).status).toBe(400);
    expect((await route.POST(post({ kind: "slack", user_id: ALICE }))).status).toBe(400);
    expect((await route.POST(post({ kind: "slack", text: 42 }))).status).toBe(400);
    expect((await route.POST(post("not json"))).status).toBe(400);
    expect((await route.POST(post({ kind: "slack" }, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await route.POST(post({ kind: "other", text: "x".repeat(5000) }))).status).toBe(413);
    expect(store.rows).toEqual([]);
  });

  it(`returns 429 after ${FEEDBACK_DAILY_LIMIT} requests in a day`, async () => {
    signInAs(ALICE);
    for (let i = 0; i < FEEDBACK_DAILY_LIMIT; i += 1) expect((await route.POST(post({ kind: "slack" }))).status).toBe(201);
    const response = await route.POST(post({ kind: "slack", text: SECRET_TEXT }));
    expect(response.status).toBe(429);
    expect((await response.json()).error).toMatchObject({ code: "rate_limited" });
  });

  it("returns 500 without details when the database fails", async () => {
    signInAs(ALICE);
    vi.mocked(createFeedbackRepository).mockReturnValue({
      send: async () => {
        throw new Error(`insert failed: ${SECRET_TEXT}`);
      },
    });
    const response = await route.POST(post({ kind: "other", text: SECRET_TEXT }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(SECRET_TEXT);
  });

  it("never writes the text to a log", async () => {
    signInAs(ALICE);
    await route.POST(post({ kind: "other", text: SECRET_TEXT }));
    await route.POST(post({ kind: "other", text: `${SECRET_TEXT}${"x".repeat(MAX_FEEDBACK_TEXT_CHARS)}` }));
    vi.mocked(createFeedbackRepository).mockReturnValue({
      send: async () => {
        throw new Error(SECRET_TEXT);
      },
    });
    await route.POST(post({ kind: "other", text: SECRET_TEXT }));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain("Acme");
  });
});
