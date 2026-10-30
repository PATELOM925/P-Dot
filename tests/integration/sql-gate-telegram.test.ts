import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, anonymousUser, errorCode, startSqlGate, user, type DefaultGrants, type SqlGate } from "../support/sql-gate";

/**
 * Database gate for decision 0020: the Telegram link table, its policies and
 * its three functions. Every check runs with the older Supabase default
 * grants and with none.
 */
const MODES: DefaultGrants[] = ["legacy", "none"];

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CHAT = `v1.${"A".repeat(16)}.${"B".repeat(40)}`;
const OTHER_CHAT = `v1.${"C".repeat(16)}.${"D".repeat(40)}`;
const KEY_1 = "11111111-1111-4111-8111-111111111111";
const KEY_2 = "22222222-2222-4222-8222-222222222222";

const CHECK_VIOLATION = "23514";
const POLICY_VIOLATION = "42501";

let gate: SqlGate;

const start = (owner: string, hash: string, anonymous = false) =>
  gate.as<{ expires: string }>(anonymous ? anonymousUser(owner) : user(owner), "select public.start_telegram_link($1) as expires", [hash]);
const confirm = async (owner: string, hash: string, chat = CHAT) =>
  (await gate.as<{ ok: boolean }>(user(owner), "select public.confirm_telegram_link($1, $2) as ok", [hash, chat])).rows[0]!.ok;
const claim = async (owner: string, key: string | null) =>
  (await gate.as<{ chat: string | null }>(user(owner), "select public.claim_telegram_send($1) as chat", [key])).rows[0]!.chat;
const row = async (owner: string) =>
  (await gate.admin<Record<string, unknown>>("select * from public.telegram_links where user_id = $1", [owner])).rows[0] ?? null;

describe.each(MODES)("Telegram links with %s default grants", (defaults) => {
  beforeAll(async () => {
    gate = await startSqlGate({ defaults });
  });

  afterAll(async () => {
    await gate?.close();
  });

  it("starts a link for 10 minutes, then finishes it once with the same code", async () => {
    const owner = await gate.createUser();
    const expires = new Date((await start(owner, HASH_A)).rows[0]!.expires).getTime();
    expect(expires - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(expires - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 5_000);

    expect(await confirm(owner, HASH_B)).toBe(false);
    expect(await confirm(owner, HASH_A)).toBe(true);
    expect(await confirm(owner, HASH_A, OTHER_CHAT)).toBe(false);
    expect(await row(owner)).toMatchObject({ chat_ciphertext: CHAT, link_code_hash: null, link_code_expires_at: null });
    expect((await row(owner))!.linked_at).not.toBeNull();
  });

  it("refuses an expired code", async () => {
    const owner = await gate.createUser();
    await start(owner, HASH_A);
    await gate.admin("update public.telegram_links set link_code_expires_at = now() - interval '1 second' where user_id = $1", [owner]);
    expect(await confirm(owner, HASH_A)).toBe(false);
    expect((await row(owner))!.chat_ciphertext).toBeNull();
  });

  it("keeps a linked chat while a new link starts, and replaces it only when the new link finishes", async () => {
    const owner = await gate.createUser();
    await start(owner, HASH_A);
    await confirm(owner, HASH_A);
    await start(owner, HASH_B);
    expect(await row(owner)).toMatchObject({ chat_ciphertext: CHAT, link_code_hash: HASH_B });
    expect(await confirm(owner, HASH_B, OTHER_CHAT)).toBe(true);
    expect((await row(owner))!.chat_ciphertext).toBe(OTHER_CHAT);
  });

  it("claims a send once for each key, and never without a linked chat", async () => {
    const owner = await gate.createUser();
    expect(await claim(owner, KEY_1)).toBeNull();
    await start(owner, HASH_A);
    expect(await claim(owner, KEY_1)).toBeNull();
    await confirm(owner, HASH_A);
    expect(await claim(owner, null)).toBeNull();
    expect(await claim(owner, KEY_1)).toBe(CHAT);
    expect(await claim(owner, KEY_1)).toBeNull();
    expect(await claim(owner, KEY_2)).toBe(CHAT);
  });

  it("keeps each user to the own row", async () => {
    const owner = await gate.createUser();
    const other = await gate.createUser();
    await start(owner, HASH_A);
    await confirm(owner, HASH_A);
    expect(await confirm(other, HASH_A)).toBe(false);
    expect(await claim(other, KEY_1)).toBeNull();
    expect((await gate.as(user(other), "select * from public.telegram_links")).rows).toEqual([]);
    expect((await gate.as(user(other), "delete from public.telegram_links where user_id = $1 returning 1", [owner])).rows).toEqual([]);
    expect(
      (await gate.as(user(other), "update public.telegram_links set chat_ciphertext = $1 where user_id = $2 returning 1", [OTHER_CHAT, owner])).rows,
    ).toEqual([]);
    expect((await row(owner))!.chat_ciphertext).toBe(CHAT);
  });

  it("refuses an anonymous demo session and the anon role", async () => {
    const owner = await gate.createUser();
    expect(await errorCode(() => start(owner, HASH_A, true))).toBe(POLICY_VIOLATION);
    expect(await errorCode(() => gate.as(anon, "select public.start_telegram_link($1)", [HASH_A]))).toBe(POLICY_VIOLATION);
    expect(await errorCode(() => gate.as(anon, "select * from public.telegram_links"))).toBe(POLICY_VIOLATION);
  });

  it("refuses a bad hash, a bad ciphertext, and a write of the owner or the creation time", async () => {
    const owner = await gate.createUser();
    expect(await errorCode(() => start(owner, "not-a-hash"))).toBe(CHECK_VIOLATION);
    await start(owner, HASH_A);
    expect(await errorCode(() => confirm(owner, HASH_A, "plain text"))).toBe(CHECK_VIOLATION);
    expect(
      await errorCode(() => gate.as(user(owner), "update public.telegram_links set user_id = gen_random_uuid() where user_id = $1", [owner])),
    ).toBe(POLICY_VIOLATION);
    expect(
      await errorCode(() => gate.as(user(owner), "update public.telegram_links set created_at = now() where user_id = $1", [owner])),
    ).toBe(POLICY_VIOLATION);
  });

  it("deletes the own row on unlink", async () => {
    const owner = await gate.createUser();
    await start(owner, HASH_A);
    await confirm(owner, HASH_A);
    expect((await gate.as(user(owner), "delete from public.telegram_links where user_id = $1 returning 1", [owner])).rows).toHaveLength(1);
    expect(await row(owner)).toBeNull();
  });
});
