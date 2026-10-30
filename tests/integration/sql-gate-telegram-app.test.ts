import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTelegramLinkRepository } from "@/server/db/telegram-links";
import { sqlGateClient } from "../support/sql-gate-client";
import { startSqlGate, type SqlGate } from "../support/sql-gate";

/** The Telegram repository against the real SQL of every migration (decision 0020), with the NULLs that rows really have. */
let gate: SqlGate;

const HASH = "c".repeat(64);
const CHAT = `v1.${"A".repeat(16)}.${"B".repeat(40)}`;

beforeAll(async () => {
  gate = await startSqlGate({ defaults: "none" });
});

afterAll(async () => {
  await gate?.close();
});

describe("Telegram link repository", () => {
  it("reads no row, a pending row with NULL chat, then a linked row", async () => {
    const owner = await gate.createUser();
    const repo = createTelegramLinkRepository(sqlGateClient(gate, owner));
    expect(await repo.getLink(owner)).toBeNull();
    const expires = await repo.startLink(HASH);
    expect(Number.isNaN(new Date(expires).getTime())).toBe(false);
    expect(await repo.getLink(owner)).toEqual({ chatCiphertext: null, linkedAt: null });
    expect(await repo.claimSend(crypto.randomUUID())).toBeNull();
    expect(await repo.confirmLink(HASH, CHAT)).toBe(true);
    const linked = (await repo.getLink(owner))!;
    expect(linked.chatCiphertext).toBe(CHAT);
    expect(typeof linked.linkedAt).toBe("string");
  });

  it("claims each key once and unlinks", async () => {
    const owner = await gate.createUser();
    const repo = createTelegramLinkRepository(sqlGateClient(gate, owner));
    await repo.startLink(HASH);
    await repo.confirmLink(HASH, CHAT);
    const key = crypto.randomUUID();
    expect(await repo.claimSend(key)).toBe(CHAT);
    expect(await repo.claimSend(key)).toBeNull();
    expect(await repo.confirmLink(HASH, CHAT)).toBe(false);
    expect(await repo.unlink(owner)).toBe(true);
    expect(await repo.unlink(owner)).toBe(false);
    expect(await repo.getLink(owner)).toBeNull();
  });

  it("does not see another user's row", async () => {
    const owner = await gate.createUser();
    const other = await gate.createUser();
    await createTelegramLinkRepository(sqlGateClient(gate, owner)).startLink(HASH);
    const repo = createTelegramLinkRepository(sqlGateClient(gate, other));
    expect(await repo.getLink(owner)).toBeNull();
    expect(await repo.confirmLink(HASH, CHAT)).toBe(false);
    expect(await repo.unlink(owner)).toBe(false);
  });
});
