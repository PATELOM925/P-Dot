import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anonymousUser, errorCode, startSqlGate, user, type DefaultGrants, type SqlGate } from "../support/sql-gate";

/**
 * Database gate for decision 0020: connected_accounts accepts a GitHub row
 * with the scope label 'read', and the providers of the live code still work.
 */
const MODES: DefaultGrants[] = ["legacy", "none"];

const CIPHERTEXT = `v1.${"A".repeat(16)}.${"B".repeat(40)}`;
const CHECK_VIOLATION = "23514";
const POLICY_VIOLATION = "42501";

let gate: SqlGate;

const save = (owner: string, provider: string, scopes: string[], options: { email?: string | null; anonymous?: boolean } = {}) =>
  gate.as<{ id: string }>(
    options.anonymous ? anonymousUser(owner) : user(owner),
    "select public.save_connected_account($1, $2, $3, $4, $5) as id",
    [provider, `conn_${owner}`, options.email === undefined ? null : options.email, scopes, CIPHERTEXT],
  );

describe.each(MODES)("GitHub connector with %s default grants", (defaults) => {
  beforeAll(async () => {
    gate = await startSqlGate({ defaults });
  });

  afterAll(async () => {
    await gate?.close();
  });

  it("saves a GitHub row with the scope label read and no address", async () => {
    const owner = await gate.createUser();
    expect((await save(owner, "github", ["read"])).rows[0]!.id).toBeTruthy();
    const rows = await gate.as<{ provider: string; scopes: string[] }>(user(owner), "select provider, scopes from connected_accounts");
    expect(rows.rows).toEqual([{ provider: "github", scopes: ["read"] }]);
  });

  it("refuses a GitHub OAuth scope, another provider's scope and an unknown provider", async () => {
    const owner = await gate.createUser();
    expect(await errorCode(() => save(owner, "github", ["repo"]))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => save(owner, "github", ["read", "write"]))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => save(owner, "github", ["default"]))).toBe(CHECK_VIOLATION);
    expect(await errorCode(() => save(owner, "vercel", ["read"]))).toBe(CHECK_VIOLATION);
  });

  it("refuses an anonymous demo session for GitHub", async () => {
    const owner = await gate.createUser();
    expect(await errorCode(() => save(owner, "github", ["read"], { anonymous: true }))).toBe(POLICY_VIOLATION);
  });

  it("keeps the providers of the live code", async () => {
    const owner = await gate.createUser();
    await save(owner, "google", ["https://www.googleapis.com/auth/gmail.readonly"], { email: "me@example.com" });
    await save(owner, "notion", ["default"]);
    await save(owner, "linear", ["read"]);
    await save(owner, "todoist", ["data:read"]);
    expect(await errorCode(() => save(owner, "linear", ["write"]))).toBe(CHECK_VIOLATION);
    const rows = await gate.as<{ provider: string }>(user(owner), "select provider from connected_accounts order by provider");
    expect(rows.rows.map((row) => row.provider)).toEqual(["google", "linear", "notion", "todoist"]);
  });
});
