import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/server/auth/session";
import type { ActionProposalRepository, DecisionResult, ExternalOutcome } from "@/server/db/action-proposals";
import type { ConnectedAccountRepository, GoogleTokenRow } from "@/server/db/connected-accounts";
import type { ActionPayload, ActionProposalDTO } from "@/types/api";
import { REVOKE_URL, TOKEN_URL, fakeGoogle, json, type GoogleCall } from "../support/fake-google";
import { WriteFaults, sweepWriteFaults } from "../support/write-faults";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/db/action-proposals", () => ({ createActionProposalRepository: vi.fn() }));
vi.mock("@/server/db/connected-accounts", () => ({ createConnectedAccountRepository: vi.fn() }));

const { getAuthContext } = await import("@/server/auth/session");
const { createActionProposalRepository } = await import("@/server/db/action-proposals");
const { createConnectedAccountRepository } = await import("@/server/db/connected-accounts");
const decisionRoute = await import("@/app/api/actions/[id]/decision/route");
const recoverRoute = await import("@/app/api/actions/[id]/recover/route");
const { sealText, tokenAssociatedData } = await import("@/server/google/crypto");
const { runExternalAction } = await import("@/server/google/external-action");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY_BYTES = new Uint8Array(32).fill(9);
const LEASE_MS = 120_000;
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const SECRET_BODY = "The secret plan for Friday";
const SECRET_ADDRESS = "sam.private@example.com";

const EMAIL: ActionPayload = { kind: "send_email", mode: "personal", to: [SECRET_ADDRESS], subject: "Lunch", body: SECRET_BODY };
const EVENT: ActionPayload = {
  kind: "create_calendar_event",
  mode: "work",
  title: "Planning",
  start: "2026-11-02T10:00:00Z",
  end: "2026-11-02T11:00:00Z",
  attendees: [SECRET_ADDRESS],
};

let now = Date.parse("2026-10-30T09:00:00Z");

interface Row {
  dto: ActionProposalDTO;
  claimId: string | null;
  subject: string | null;
  attempt: number;
  unknown: boolean;
}

/** The contract of the database functions in 20261030000000_google_connection.sql, in memory. */
class FakeProposals implements ActionProposalRepository {
  rows = new Map<string, Row>();
  constructor(private readonly accounts: FakeAccounts) {}

  add(payload: ActionPayload): string {
    const id = crypto.randomUUID();
    this.rows.set(id, {
      dto: {
        id,
        conversationId: null,
        payload,
        summary: "Do it",
        status: "proposed",
        result: null,
        createdAt: new Date(now).toISOString(),
        decidedAt: null,
        executionStartedAt: null,
        verified: false,
      },
      claimId: null,
      subject: null,
      attempt: 0,
      unknown: false,
    });
    return id;
  }

  private answer(outcome: DecisionResult["outcome"], row: Row, claimId?: string): DecisionResult {
    return {
      outcome,
      proposal: { ...row.dto },
      row: { id: row.dto.id, status: row.dto.status },
      ...(claimId ? { claimId } : {}),
      accountSubject: row.subject,
    };
  }

  private connectedSubject(): string | null {
    const account = this.accounts.row;
    return account && account.status === "connected" ? account.subject : null;
  }

  async createProposal(): Promise<ActionProposalDTO> {
    throw new Error("not used");
  }
  async listProposals() {
    return [...this.rows.values()].map((row) => row.dto);
  }
  async getProposal(_userId: string, id: string) {
    const row = this.rows.get(id);
    return row ? { ...row.dto } : null;
  }

  async decide(id: string, decision: "approve" | "reject"): Promise<DecisionResult> {
    const row = this.rows.get(id);
    if (!row) return { outcome: "not_found", proposal: null, row: null };
    if (row.dto.status !== "proposed") return this.answer("already_decided", row);
    if (decision === "reject") {
      row.dto.status = "rejected";
      row.dto.verified = true;
      return this.answer("rejected", row);
    }
    const subject = this.connectedSubject();
    if (!subject) return this.answer("not_connected", row);
    row.dto.status = "executing";
    row.dto.decidedAt = new Date(now).toISOString();
    row.dto.executionStartedAt = new Date(now).toISOString();
    row.dto.verified = true;
    row.claimId = crypto.randomUUID();
    row.subject = subject;
    row.attempt = 1;
    return this.answer("executing", row, row.claimId);
  }

  async finishExternal(id: string, claimId: string, outcome: ExternalOutcome): Promise<DecisionResult> {
    const row = this.rows.get(id);
    if (!row) return { outcome: "not_found", proposal: null, row: null };
    if (row.dto.status !== "executing") return this.answer("already_decided", row);
    if (row.claimId !== claimId) return this.answer("stale_claim", row);
    if (!outcome.succeeded && row.attempt > 1) {
      row.unknown = true;
      return this.answer("outcome_unknown", row);
    }
    row.dto.status = outcome.succeeded ? "executed" : "failed";
    row.dto.result = outcome.succeeded ? outcome.result : { error: "execution_failed", reason: outcome.reason };
    row.dto.verified = true;
    row.claimId = null;
    return this.answer(row.dto.status as "executed" | "failed", row);
  }

  async reclaimExternal(id: string, leaseSeconds: number): Promise<DecisionResult> {
    const row = this.rows.get(id);
    if (!row) return { outcome: "not_found", proposal: null, row: null };
    if (row.dto.status !== "executing") return this.answer("already_decided", row);
    if (Date.parse(row.dto.executionStartedAt!) > now - leaseSeconds * 1000) return this.answer("busy", row);
    if (row.unknown) return this.answer("outcome_unknown", row);
    if (this.connectedSubject() !== row.subject) return this.answer("account_changed", row);
    if (row.dto.payload.kind !== "create_calendar_event") return this.answer("outcome_unknown", row);
    row.claimId = crypto.randomUUID();
    row.dto.executionStartedAt = new Date(now).toISOString();
    row.attempt += 1;
    return this.answer("claimed", row, row.claimId);
  }

  async settleUnknownExternal(id: string, leaseSeconds: number, done: boolean): Promise<DecisionResult> {
    const row = this.rows.get(id);
    if (!row) return { outcome: "not_found", proposal: null, row: null };
    if (row.dto.status !== "executing") return this.answer("already_decided", row);
    if (row.dto.payload.kind === "create_calendar_event" && !row.unknown && this.connectedSubject() === row.subject) {
      return this.answer("invalid", row);
    }
    if (Date.parse(row.dto.executionStartedAt!) > now - leaseSeconds * 1000) return this.answer("busy", row);
    row.dto.status = done ? "executed" : "failed";
    row.dto.result = done ? { userConfirmed: true } : { error: "execution_failed", reason: "not_done" };
    row.dto.verified = false;
    row.claimId = null;
    return this.answer(row.dto.status as "executed" | "failed", row);
  }
}

class FakeAccounts implements ConnectedAccountRepository {
  row: GoogleTokenRow | null = null;
  async getGoogleConnection() {
    return this.row ? { email: this.row.email, scopes: this.row.scopes, status: this.row.status } : null;
  }
  async getGoogleToken() {
    return this.row ? { ...this.row } : null;
  }
  async saveGoogle() {}
  async markGoogleNeedsReconnect(_userId: string, ciphertext: string) {
    if (this.row?.tokenCiphertext === ciphertext) this.row.status = "needs_reconnect";
  }
  async deleteGoogle() {
    return false;
  }
}

/** Google: the token endpoint, Gmail send and one primary calendar that refuses a second event with the same ID. */
class FakeGoogleAccount {
  sent: GoogleCall[] = [];
  events = new Map<string, unknown>();
  tokenStatus = 200;
  /** What the next send or insert does after Google acted (or not). */
  nextWrite: "ok" | "lose_after_acting" | "reject_400" | "fail_500_before_acting" = "ok";
  readonly google = fakeGoogle({
    [TOKEN_URL]: () => (this.tokenStatus === 200 ? json({ access_token: "at", expires_in: 3600 }) : json({ error: "server" }, this.tokenStatus)),
    [REVOKE_URL]: () => json({}),
    [SEND_URL]: (call) => this.write(() => {
      this.sent.push(call);
      return json({ id: `msg${this.sent.length}`, threadId: "t" });
    }),
    [EVENTS_URL]: (call) => this.write(() => {
      const event = JSON.parse(call.body) as { id: string };
      if (this.events.has(event.id)) return json({ error: { errors: [{ reason: "duplicate" }] } }, 409);
      this.events.set(event.id, event);
      return json({ id: event.id });
    }),
  });

  private write(act: () => Response): Response | Promise<Response> {
    const mode = this.nextWrite;
    this.nextWrite = "ok";
    if (mode === "reject_400") return json({ error: { errors: [{ reason: "invalidArgument" }] } }, 400);
    if (mode === "fail_500_before_acting") return json({}, 500);
    const response = act();
    if (mode === "lose_after_acting") return Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    return response;
  }
}

let accounts: FakeAccounts;
let proposals: FakeProposals;
let google: FakeGoogleAccount;
let logs: string[];

async function connect(subject = "sub-a") {
  accounts.row = {
    subject,
    email: "me@example.com",
    scopes: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.events.owned",
    ],
    status: "connected",
    tokenCiphertext: await sealText(KEY_BYTES, `refresh-${subject}`, tokenAssociatedData(ALICE, "google")),
  };
}

function setUp() {
  accounts = new FakeAccounts();
  proposals = new FakeProposals(accounts);
  google = new FakeGoogleAccount();
  vi.mocked(createActionProposalRepository).mockReturnValue(proposals);
  vi.mocked(createConnectedAccountRepository).mockReturnValue(accounts);
  vi.stubGlobal("fetch", google.google.fetch);
}

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const approve = (id: string) => decisionRoute.POST(post(`/api/actions/${id}/decision`, { decision: "approve" }), params(id));
const recover = (id: string, answer?: "done" | "not_done") =>
  recoverRoute.POST(post(`/api/actions/${id}/recover`, answer ? { answer } : {}), params(id));
const status = (id: string) => proposals.rows.get(id)!.dto.status;

beforeEach(async () => {
  now = Date.parse("2026-10-30T09:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.mocked(getAuthContext).mockResolvedValue({ userId: ALICE, email: null, supabase: {} as SupabaseClient } satisfies AuthContext);
  vi.stubEnv("SITE_URL", "http://localhost");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "client-secret");
  vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", Buffer.from(KEY_BYTES).toString("base64"));
  logs = [];
  for (const method of ["info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
  }
  setUp();
  await connect();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("approving an external action", () => {
  it("sends an approved email once and stores the message ID", async () => {
    const id = proposals.add(EMAIL);
    const response = await approve(id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, status: "executed", result: { messageId: "msg1" } });
    expect(google.sent).toHaveLength(1);
    expect(Buffer.from(JSON.parse(google.sent[0]!.body).raw, "base64url").toString()).toContain(`To: ${SECRET_ADDRESS}`);
    expect((await approve(id)).status).toBe(409);
    expect(google.sent).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(SECRET_BODY);
    expect(logs.join("\n")).not.toContain(SECRET_ADDRESS);
  });

  it("adds an approved event with the proposal ID as the event ID", async () => {
    const id = proposals.add(EVENT);
    expect((await approve(id)).status).toBe(200);
    expect([...google.events.keys()]).toEqual([id.replaceAll("-", "")]);
    expect(proposals.rows.get(id)!.dto.result).toEqual({ eventId: id.replaceAll("-", "") });
  });

  it.each([
    ["no connection", async () => { accounts.row = null; }, 409],
    ["a connection that needs a reconnect", async () => { accounts.row!.status = "needs_reconnect"; }, 409],
    ["a missing send scope", async () => { accounts.row!.scopes = ["https://www.googleapis.com/auth/gmail.readonly"]; }, 409],
    ["a token endpoint outage", async () => { google.tokenStatus = 503; }, 503],
    ["Google not set up", async () => { vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", ""); }, 503],
  ])("claims nothing and calls no Gmail API with %s; the proposal keeps waiting", async (_name, arrange, expected) => {
    const id = proposals.add(EMAIL);
    await arrange();
    expect((await approve(id)).status).toBe(expected);
    expect(status(id)).toBe("proposed");
    expect(google.sent).toEqual([]);
  });

  it("stores failed with a reason when Google refuses with a 4xx", async () => {
    const id = proposals.add(EMAIL);
    google.nextWrite = "reject_400";
    const response = await approve(id);
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toBe("Google refused this action. Nothing was sent.");
    expect(proposals.rows.get(id)!.dto.result).toEqual({ error: "execution_failed", reason: "google_rejected" });
  });

  it("an email whose outcome is unknown is never sent again; the user's answer settles it, not verified", async () => {
    const id = proposals.add(EMAIL);
    google.nextWrite = "lose_after_acting";
    const first = await approve(id);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ id, status: "executing" });
    expect((await approve(id)).status).toBe(409);
    expect((await recover(id)).status).toBe(409);
    now += LEASE_MS + 1000;
    const check = await recover(id);
    expect(check.status).toBe(409);
    expect((await check.json()).error.message).toBe("P-Dot cannot check this by itself. Tell P-Dot if it happened.");
    const answered = await recover(id, "done");
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ status: "executed", verified: false, result: { userConfirmed: true } });
    expect(google.sent).toHaveLength(1);
  });

  it("a 5xx from Gmail is an unknown outcome, not a failure", async () => {
    const id = proposals.add(EMAIL);
    google.nextWrite = "fail_500_before_acting";
    expect((await approve(id)).status).toBe(202);
    expect(status(id)).toBe("executing");
  });

  it("an event whose response was lost is checked again and Google refuses a second copy", async () => {
    const id = proposals.add(EVENT);
    google.nextWrite = "lose_after_acting";
    expect((await approve(id)).status).toBe(202);
    now += LEASE_MS + 1000;
    const again = await recover(id);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "executed", verified: true });
    expect(google.events.size).toBe(1);
  });

  it("Check again during a token outage starts no new lease and calls no Calendar API", async () => {
    const id = proposals.add(EVENT);
    google.nextWrite = "lose_after_acting";
    expect((await approve(id)).status).toBe(202);
    const startedAt = proposals.rows.get(id)!.dto.executionStartedAt;
    now += LEASE_MS + 1000;
    google.tokenStatus = 503;
    const reclaim = vi.spyOn(proposals, "reclaimExternal");
    const inserts = () => google.google.calls.filter((call) => call.url.startsWith(EVENTS_URL)).length;
    const before = inserts();
    const check = await recover(id);
    expect(check.status).toBe(503);
    expect(reclaim).not.toHaveBeenCalled();
    expect(proposals.rows.get(id)!.dto.executionStartedAt).toBe(startedAt);
    expect(inserts()).toBe(before);
    google.tokenStatus = 200;
    expect((await recover(id)).status).toBe(200);
    expect(google.events.size).toBe(1);
  });

  it("Check again without the calendar scope asks for a reconnect, not for the user's answer, and starts no lease", async () => {
    const id = proposals.add(EVENT);
    google.nextWrite = "lose_after_acting";
    expect((await approve(id)).status).toBe(202);
    now += LEASE_MS + 1000;
    accounts.row!.scopes = ["https://www.googleapis.com/auth/gmail.send"];
    const reclaim = vi.spyOn(proposals, "reclaimExternal");
    const check = await recover(id);
    expect(check.status).toBe(409);
    expect((await check.json()).error).toMatchObject({ code: "reconnect_required", message: "Connect Google again to finish checking." });
    expect(reclaim).not.toHaveBeenCalled();
    expect(status(id)).toBe("executing");
  });

  it("does not insert into another account after a reconnect: the user answers instead", async () => {
    const id = proposals.add(EVENT);
    google.nextWrite = "lose_after_acting";
    expect((await approve(id)).status).toBe(202);
    await connect("sub-b");
    now += LEASE_MS + 1000;
    expect((await recover(id)).status).toBe(409);
    expect(google.google.calls.filter((call) => call.url.startsWith(EVENTS_URL))).toHaveLength(1);
    expect((await recover(id, "not_done")).status).toBe(200);
    expect(proposals.rows.get(id)!.dto).toMatchObject({ status: "failed", verified: false });
  });

  it("refuses an anonymous demo session: 403 account_required, nothing claimed and no Google call", async () => {
    vi.mocked(getAuthContext).mockResolvedValue({ userId: ALICE, email: null, isAnonymous: true, supabase: {} as SupabaseClient });
    const id = proposals.add(EMAIL);
    for (const response of [await approve(id), await recover(id), await recover(id, "done")]) {
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("account_required");
    }
    expect(status(id)).toBe("proposed");
    expect(google.google.calls).toEqual([]);
  });

  it("reports account_changed without calling Google when the claim is for another account", async () => {
    const result = await runExternalAction(
      { subject: "sub-b", scopes: ["https://www.googleapis.com/auth/gmail.send"], fetch: google.google.fetch, accessToken: async () => "at" },
      { id: crypto.randomUUID(), payload: EMAIL as Extract<ActionPayload, { kind: "send_email" }>, accountSubject: "sub-a" },
      "r",
    );
    expect(result).toEqual({ succeeded: false, reason: "account_changed" });
    expect(google.sent).toEqual([]);
  });
});

describe("write faults on approve, then recovery", () => {
  /**
   * Makes each write fail (refused or lost), up to two faults. After the
   * request: no row is left in a state that hides an outcome, the HTTP status
   * matches the row, and the retry and recovery paths never act twice.
   */
  async function scenario(payload: ActionPayload, faults: WriteFaults) {
    setUp();
    await connect();
    faults.wrap(proposals, ["decide", "finishExternal", "reclaimExternal", "settleUnknownExternal"], { label: "db.rpc" });
    faults.wrap(proposals, ["getProposal"], { label: "db.read", read: true });
    faults.wrap(accounts, ["getGoogleToken"], { label: "db.read", read: true });
    faults.wrap(accounts, ["markGoogleNeedsReconnect"], { label: "db.write" });
    const id = proposals.add(payload);
    const acted = () => (payload.kind === "send_email" ? google.sent.length : google.events.size);
    const answer = () => (acted() > 0 ? "done" : "not_done");

    // Approve. The HTTP status matches what the row says.
    const response = await approve(id);
    const afterApprove = status(id);
    expect(acted()).toBeLessThanOrEqual(1);
    if (afterApprove === "executed") expect([200, 202, 500]).toContain(response.status);
    else if (afterApprove === "proposed") {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(acted()).toBe(0);
    } else expect([202, 500]).toContain(response.status);

    // A second click, then the recovery calls, still with faults armed. None acts twice.
    const before = acted();
    const retry = await approve(id);
    if (afterApprove !== "proposed") {
      expect([409, 500]).toContain(retry.status);
      expect(acted()).toBe(before);
    }
    now += LEASE_MS + 1000;
    if (status(id) === "executing") {
      await recover(id);
      if (status(id) === "executing") await recover(id, answer());
    }
    expect(acted()).toBeLessThanOrEqual(1);
    faults.disarm();

    // Repair without faults: at most a few more recovery rounds settle every row.
    for (let round = 0; round < 3 && status(id) !== "executed" && status(id) !== "failed"; round += 1) {
      now += LEASE_MS + 1000;
      if (status(id) === "proposed") {
        await approve(id);
        continue;
      }
      await recover(id);
      if (status(id) === "executing") await recover(id, answer());
    }
    expect(["executed", "failed"]).toContain(status(id));
    // Done exactly once, or, when the user said it was not done, never.
    expect(acted()).toBe(status(id) === "executed" ? 1 : 0);
  }

  it.each([
    ["send_email", EMAIL],
    ["create_calendar_event", EVENT],
  ])("%s", async (_kind, payload) => {
    const cases = await sweepWriteFaults((faults) => scenario(payload, faults));
    const labels = new Set(cases.map((c) => c.at(-1)!.label));
    expect(labels).toContain("db.rpc.decide");
    expect(labels).toContain("db.rpc.finishExternal");
    if (payload.kind === "send_email") expect(labels).toContain("db.rpc.settleUnknownExternal");
    if (payload.kind === "create_calendar_event") expect(labels).toContain("db.rpc.reclaimExternal");
  });
});
