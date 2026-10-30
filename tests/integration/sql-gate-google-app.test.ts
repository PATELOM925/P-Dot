import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { createConnectedAccountRepository } from "@/server/db/connected-accounts";
import { sqlGateClient } from "../support/sql-gate-client";
import { startSqlGate, type SqlGate } from "../support/sql-gate";

/** The connected accounts repository against the real SQL of every migration (decision 0014). */
let gate: SqlGate;

const READ = "https://www.googleapis.com/auth/gmail.readonly";
const SEND = "https://www.googleapis.com/auth/gmail.send";
const CALENDAR = "https://www.googleapis.com/auth/calendar.events.owned";
const CIPHERTEXT = `v1.${"A".repeat(16)}.${"B".repeat(40)}`;
const NEWER = `v1.${"C".repeat(16)}.${"D".repeat(40)}`;

beforeAll(async () => {
  gate = await startSqlGate({ defaults: "none" });
});

afterAll(async () => {
  await gate?.close();
});

describe("connected accounts repository", () => {
  it("saves, reads the status without the ciphertext, reads the token row, and replaces on reconnect", async () => {
    const owner = await gate.createUser();
    const repo = createConnectedAccountRepository(sqlGateClient(gate, owner));
    expect(await repo.getGoogleConnection(owner)).toBeNull();
    await repo.saveGoogle("sub-1", "a@example.com", [READ], CIPHERTEXT);
    const status = await repo.getGoogleConnection(owner);
    expect(status).toEqual({ email: "a@example.com", scopes: [READ], status: "connected" });
    expect(JSON.stringify(status)).not.toContain(CIPHERTEXT);
    expect(await repo.getGoogleToken(owner)).toEqual({
      subject: "sub-1",
      email: "a@example.com",
      scopes: [READ],
      status: "connected",
      tokenCiphertext: CIPHERTEXT,
    });
    await repo.saveGoogle("sub-2", "b@example.com", [READ, SEND], NEWER);
    expect(await repo.getGoogleToken(owner)).toMatchObject({ subject: "sub-2", scopes: [READ, SEND], tokenCiphertext: NEWER });
  });

  it("marks needs_reconnect only while the row has the same ciphertext", async () => {
    const owner = await gate.createUser();
    const repo = createConnectedAccountRepository(sqlGateClient(gate, owner));
    await repo.saveGoogle("sub-1", "a@example.com", [READ], NEWER);
    await repo.markGoogleNeedsReconnect(owner, CIPHERTEXT);
    expect((await repo.getGoogleConnection(owner))!.status).toBe("connected");
    await repo.markGoogleNeedsReconnect(owner, NEWER);
    expect((await repo.getGoogleConnection(owner))!.status).toBe("needs_reconnect");
    await repo.saveGoogle("sub-1", "a@example.com", [READ], CIPHERTEXT);
    expect((await repo.getGoogleConnection(owner))!.status).toBe("connected");
  });

  it("runs the external action calls of the proposal repository against the real functions", async () => {
    const owner = await gate.createUser();
    const client = sqlGateClient(gate, owner);
    await createConnectedAccountRepository(client).saveGoogle("sub-1", "a@example.com", [SEND, CALENDAR], CIPHERTEXT);
    const repo = createActionProposalRepository(client);
    const email = await repo.createProposal(owner, {
      conversationId: null,
      payload: { kind: "send_email", mode: "personal", to: ["sam@example.com"], subject: "Lunch", body: "Noon?" },
      summary: "Email Sam",
    });
    expect(await repo.getProposal(owner, email.id)).toMatchObject({ id: email.id, status: "proposed", executionStartedAt: null });

    const claimed = await repo.decide(email.id, "approve");
    expect(claimed).toMatchObject({ outcome: "executing", accountSubject: "sub-1", proposal: { status: "executing" } });
    expect(claimed.claimId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(claimed.proposal)).not.toContain(claimed.claimId!);
    expect(claimed.proposal!.executionStartedAt).toEqual(expect.any(String));
    expect((await repo.decide(email.id, "approve")).claimId).toBeUndefined();
    const listed = await repo.listProposals(owner, "executing", 10);
    expect(listed.map((p) => p.id)).toEqual([email.id]);

    const done = await repo.finishExternal(email.id, claimed.claimId!, { succeeded: true, result: { messageId: "18c2f0a1b2c3d4e5" } });
    expect(done).toMatchObject({ outcome: "executed", proposal: { status: "executed", verified: true, result: { messageId: "18c2f0a1b2c3d4e5" } } });

    const event = await repo.createProposal(owner, {
      conversationId: null,
      payload: { kind: "create_calendar_event", mode: "work", title: "Plan", start: "2026-11-02T10:00:00Z", end: "2026-11-02T11:00:00Z", attendees: [] },
      summary: "Add the event",
    });
    const eventClaim = await repo.decide(event.id, "approve");
    expect((await repo.reclaimExternal(event.id, 120)).outcome).toBe("busy");
    await gate.admin("update action_proposals set execution_started_at = now() - interval '5 minutes' where id = $1", [event.id]);
    const reclaimed = await repo.reclaimExternal(event.id, 120);
    expect(reclaimed.outcome).toBe("claimed");
    expect(reclaimed.claimId).not.toBe(eventClaim.claimId);
    const failed = await repo.finishExternal(event.id, reclaimed.claimId!, { succeeded: false, reason: "google_rejected" });
    expect(failed.outcome).toBe("outcome_unknown");
    await gate.admin("update action_proposals set execution_started_at = now() - interval '5 minutes' where id = $1", [event.id]);
    expect(await repo.settleUnknownExternal(event.id, 120, true)).toMatchObject({
      outcome: "executed",
      proposal: { status: "executed", verified: false, result: { userConfirmed: true } },
    });
  });

  it("deletes only the caller's row, and another user's reads see nothing", async () => {
    const alice = await gate.createUser();
    const bob = await gate.createUser();
    const aliceRepo = createConnectedAccountRepository(sqlGateClient(gate, alice));
    const bobRepo = createConnectedAccountRepository(sqlGateClient(gate, bob));
    await aliceRepo.saveGoogle("sub-a", "a@example.com", [READ], CIPHERTEXT);
    expect(await bobRepo.getGoogleToken(alice)).toBeNull();
    expect(await bobRepo.deleteGoogle(alice)).toBe(false);
    expect(await aliceRepo.deleteGoogle(alice)).toBe(true);
    expect(await aliceRepo.deleteGoogle(alice)).toBe(false);
    expect(await aliceRepo.getGoogleConnection(alice)).toBeNull();
  });
});
