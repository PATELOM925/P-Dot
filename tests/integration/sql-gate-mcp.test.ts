import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, anonymousUser, errorCode, startSqlGate, user, type DefaultGrants, type SqlGate } from "../support/sql-gate";

/**
 * Database gate for decision 0016: connected_accounts accepts the MCP
 * providers, and every Google row and write of the live code still works.
 * Every check runs with the older Supabase default grants and with none.
 */
const MODES: DefaultGrants[] = ["legacy", "none"];

const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
const CIPHERTEXT = `v1.${"A".repeat(16)}.${"B".repeat(40)}`;
const NEWER = `v1.${"C".repeat(16)}.${"D".repeat(40)}`;
const sealedOfLength = (length: number) => `v1.${"A".repeat(16)}.${"B".repeat(length - 20)}`;

const CHECK_VIOLATION = "23514";
const POLICY_VIOLATION = "42501";

let gate: SqlGate;

const save = (
  owner: string,
  provider: string,
  scopes: (string | null)[],
  options: { ciphertext?: string; email?: string | null; subject?: string; anonymous?: boolean } = {},
) =>
  gate.as<{ id: string }>(
    options.anonymous ? anonymousUser(owner) : user(owner),
    "select public.save_connected_account($1, $2, $3, $4, $5) as id",
    [
      provider,
      options.subject ?? `conn_${owner}`,
      options.email === undefined ? null : options.email,
      scopes,
      options.ciphertext ?? CIPHERTEXT,
    ],
  );

describe.each(MODES)("MCP connectors with %s default grants", (defaults) => {
  beforeAll(async () => {
    gate = await startSqlGate({ defaults });
  });

  afterAll(async () => {
    await gate?.close();
  });

  it("saves a Notion, a Linear and a Todoist row with no address, and replaces each in place", async () => {
    const owner = await gate.createUser();
    for (const [provider, scope] of [
      ["notion", "default"],
      ["linear", "read"],
      ["todoist", "data:read_write"],
    ] as const) {
      const first = (await save(owner, provider, [scope])).rows[0]!.id;
      const second = (await save(owner, provider, [scope], { ciphertext: NEWER, subject: "conn_new" })).rows[0]!.id;
      expect(second).toBe(first);
    }
    const rows = await gate.as<{ provider: string; account_email: string | null; account_subject: string; token_ciphertext: string }>(
      user(owner),
      "select provider, account_email, account_subject, token_ciphertext from connected_accounts order by provider",
    );
    expect(rows.rows).toEqual(
      ["linear", "notion", "todoist"].map((provider) => ({
        provider,
        account_email: null,
        account_subject: "conn_new",
        token_ciphertext: NEWER,
      })),
    );
  });

  it("refuses an unknown provider, a scope of another provider, a write scope, no scope and a NULL scope", async () => {
    const owner = await gate.createUser();
    expect(await errorCode(() => save(owner, "github", ["repo"]))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => save(owner, "notion", ["read"]))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => save(owner, "linear", ["write"]))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => save(owner, "linear", ["read", "write"]))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => save(owner, "todoist", ["data:delete"]))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => save(owner, "notion", [GMAIL_READ]))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => save(owner, "notion", []))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => save(owner, "notion", ["default", null]))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => save(owner, "google", ["default"], { email: "me@example.com" }))).toBe(CHECK_VIOLATION);
  });

  it("allows 12,288 ciphertext characters for an MCP row and keeps 4,096 for Google", async () => {
    const owner = await gate.createUser();
    expect(await errorCode(() => save(owner, "notion", ["default"], { ciphertext: sealedOfLength(12_288) }))).toBeNull();
    expect(await errorCode(() => save(owner, "linear", ["read"], { ciphertext: sealedOfLength(12_289) }))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => save(owner, "linear", ["read"], { ciphertext: "plain-token" }))).toBe(CHECK_VIOLATION);
    expect(
      await errorCode(() => save(owner, "google", [GMAIL_READ], { email: "me@example.com", ciphertext: sealedOfLength(4_097) })),
    ).toBe(CHECK_VIOLATION);
    expect(
      await errorCode(() => save(owner, "google", [GMAIL_READ], { email: "me@example.com", ciphertext: sealedOfLength(4_096) })),
    ).toBeNull();
  });

  it("still needs an address for Google", async () => {
    const owner = await gate.createUser();
    expect(await errorCode(() => save(owner, "google", [GMAIL_READ], { email: null }))).toBe(CHECK_VIOLATION);
    expect(
      await errorCode(() =>
        gate.as(
          user(owner),
          "insert into connected_accounts (provider, account_subject, account_email, scopes, token_ciphertext) values ('google', 's', null, $1, $2)",
          [[GMAIL_READ], CIPHERTEXT],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("refuses an anonymous session for an MCP row, and keeps Google as it was", async () => {
    const owner = await gate.createUser();
    expect(await errorCode(() => save(owner, "notion", ["default"], { anonymous: true }))).toBe(POLICY_VIOLATION);
    await save(owner, "linear", ["read"]);
    const changed = gate.as(
      anonymousUser(owner),
      "update connected_accounts set token_ciphertext = $2 where user_id = $1 and provider = 'linear'",
      [owner, NEWER],
    );
    expect(await errorCode(() => changed)).toBe(POLICY_VIOLATION);
    expect(await errorCode(() => save(owner, "google", [GMAIL_READ], { email: "me@example.com", anonymous: true }))).toBeNull();
    const left = await gate.admin<{ token_ciphertext: string }>(
      "select token_ciphertext from connected_accounts where user_id = $1 and provider = 'linear'",
      [owner],
    );
    expect(left.rows).toEqual([{ token_ciphertext: CIPHERTEXT }]);
  });

  it("lets the owner swap the ciphertext only while it still has the one that was read", async () => {
    const owner = await gate.createUser();
    await save(owner, "notion", ["default"]);
    const swap = (from: string, to: string) =>
      gate.as(
        user(owner),
        "update connected_accounts set token_ciphertext = $3 where user_id = $1 and provider = 'notion' and token_ciphertext = $2 and status = 'connected'",
        [owner, from, to],
      );
    expect((await swap(CIPHERTEXT, NEWER)).affectedRows).toBe(1);
    expect((await swap(CIPHERTEXT, sealedOfLength(60))).affectedRows).toBe(0);
    const marked = await gate.as(
      user(owner),
      "update connected_accounts set status = 'needs_reconnect' where user_id = $1 and provider = 'notion' and token_ciphertext = $2",
      [owner, NEWER],
    );
    expect(marked.affectedRows).toBe(1);
    expect((await swap(NEWER, CIPHERTEXT)).affectedRows).toBe(0);
    const deleted = await gate.as(
      user(owner),
      "delete from connected_accounts where user_id = $1 and provider = 'notion' and token_ciphertext = $2",
      [owner, CIPHERTEXT],
    );
    expect(deleted.affectedRows).toBe(0);
  });

  it("keeps each user's MCP row apart", async () => {
    const alice = await gate.createUser();
    const bob = await gate.createUser();
    await save(bob, "todoist", ["data:read"]);
    expect((await gate.as(user(alice), "select * from connected_accounts where user_id = $1", [bob])).rows).toEqual([]);
    expect((await gate.as(user(alice), "delete from connected_accounts where user_id = $1", [bob])).affectedRows).toBe(0);
    expect(await errorCode(() => gate.as(anon, "select * from connected_accounts"))).toBe(POLICY_VIOLATION);
  });

  it("runs the live Google statements unchanged on the new schema", async () => {
    const owner = await gate.createUser();
    await save(owner, "google", [GMAIL_READ], { email: "me@example.com", subject: "google-sub" });
    await save(owner, "notion", ["default"]);
    const status = await gate.as(
      user(owner),
      "select account_email, scopes, status from connected_accounts where user_id = $1 and provider = 'google'",
      [owner],
    );
    expect(status.rows).toEqual([{ account_email: "me@example.com", scopes: [GMAIL_READ], status: "connected" }]);
    const marked = await gate.as(
      user(owner),
      "update connected_accounts set status = 'needs_reconnect' where user_id = $1 and provider = 'google' and token_ciphertext = $2",
      [owner, CIPHERTEXT],
    );
    expect(marked.affectedRows).toBe(1);
    const deleted = await gate.as(
      user(owner),
      "delete from connected_accounts where user_id = $1 and provider = 'google' and token_ciphertext = $2",
      [owner, CIPHERTEXT],
    );
    expect(deleted.affectedRows).toBe(1);
    const left = await gate.as<{ provider: string }>(user(owner), "select provider from connected_accounts");
    expect(left.rows).toEqual([{ provider: "notion" }]);
  });

  it("keeps a Google row that the older schema stored", async () => {
    const seeded = await startSqlGate({
      defaults,
      beforeMigration: {
        file: "20261031000000_mcp_connectors.sql",
        sql: `insert into auth.users (id) values ('00000000-0000-4000-8000-000000000001');
          insert into public.connected_accounts (user_id, provider, account_subject, account_email, scopes, token_ciphertext)
          values ('00000000-0000-4000-8000-000000000001', 'google', 's', 'old@example.com', array['${GMAIL_READ}'], '${CIPHERTEXT}');`,
      },
    });
    try {
      const rows = await seeded.admin<{ provider: string; account_email: string }>("select provider, account_email from connected_accounts");
      expect(rows.rows).toEqual([{ provider: "google", account_email: "old@example.com" }]);
    } finally {
      await seeded.close();
    }
  }, 30_000);
});
