import { describe, expect, it } from "vitest";
import { openBundle, sealBundle } from "@/server/mcp/bundle";
import { MCP_SERVERS } from "@/server/mcp/catalog";
import { McpAccessError, openMcpAccess, type McpAccessDeps } from "@/server/mcp/token-store";
import { createBarrier } from "../support/barrier";
import { FakeMcpAccounts, TEST_KEY, TEST_USER, fakeApp, seedConnection, type FakeApp } from "../support/fake-mcp";

const notion = MCP_SERVERS.notion;
const quiet = () => undefined;

function deps(accounts: FakeMcpAccounts, app: FakeApp, extra: Partial<McpAccessDeps> = {}): McpAccessDeps {
  return {
    repo: accounts,
    key: TEST_KEY,
    server: notion,
    userId: TEST_USER,
    fetch: app.fetch,
    requestId: "req",
    log: quiet,
    sleep: async () => undefined,
    ...extra,
  };
}

async function bundleOf(accounts: FakeMcpAccounts) {
  const row = (await accounts.getMcp(TEST_USER, "notion"))!;
  return { row, bundle: await openBundle(TEST_KEY, TEST_USER, notion, row.subject, row.tokenCiphertext) };
}

const reason = async (work: Promise<unknown>) => {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof McpAccessError) return error.reason;
    throw error;
  }
};

describe("MCP token store", () => {
  it("uses a valid access token and writes nothing", async () => {
    const accounts = new FakeMcpAccounts();
    const app = fakeApp("notion");
    const seeded = await seedConnection(accounts, app, "notion");
    const access = await openMcpAccess(deps(accounts, app));
    expect(await access.token(false)).toBe(seeded.tokens.access_token);
    expect((await accounts.getMcp(TEST_USER, "notion"))!.tokenCiphertext).toBe(seeded.sealed);
    expect(app.refreshUses.size).toBe(0);
  });

  it("refreshes an access token that ends soon, stores the rotated token, and the next request uses it", async () => {
    const accounts = new FakeMcpAccounts();
    const app = fakeApp("notion");
    const seeded = await seedConnection(accounts, app, "notion", { accessExpiresAt: Date.now() + 30_000 });
    const access = await openMcpAccess(deps(accounts, app));
    const token = await access.token(false);
    expect(token).not.toBe(seeded.tokens.access_token);
    const { bundle } = await bundleOf(accounts);
    expect(bundle!.accessToken).toBe(token);
    expect(bundle!.claim).toBeNull();
    expect(bundle!.refreshToken).not.toBe(seeded.tokens.refresh_token);
    expect(await (await openMcpAccess(deps(accounts, app))).token(false)).toBe(token);
    expect(app.refreshUses.get(seeded.tokens.refresh_token!)).toBe(1);
  });

  it("sends one refresh when two requests need one at the same time", async () => {
    const accounts = new FakeMcpAccounts();
    const app = fakeApp("notion");
    const seeded = await seedConnection(accounts, app, "notion", { accessExpiresAt: Date.now() + 1000 });
    const gate = createBarrier();
    app.holdRefresh(() => gate.wait());
    let a: Promise<string> = Promise.resolve("");
    const first = await openMcpAccess(deps(accounts, app));
    const second = await openMcpAccess(
      deps(accounts, app, {
        sleep: async () => {
          gate.release();
          await a;
        },
      }),
    );
    a = first.token(false);
    await gate.reached;
    const b = second.token(false);
    const [ta, tb] = await Promise.all([a, b]);
    expect(ta).toBe(tb);
    expect(app.refreshUses.get(seeded.tokens.refresh_token!)).toBe(1);
    expect(app.deadGrants.size).toBe(0);
  });

  it("drops the new token when a disconnect happens during the refresh", async () => {
    const accounts = new FakeMcpAccounts();
    const app = fakeApp("notion");
    await seedConnection(accounts, app, "notion", { accessExpiresAt: Date.now() + 1000 });
    const gate = createBarrier();
    app.holdRefresh(() => gate.wait());
    const access = await openMcpAccess(deps(accounts, app));
    const pending = access.token(false);
    await gate.reached;
    const row = (await accounts.getMcp(TEST_USER, "notion"))!;
    expect(await accounts.deleteMcp(TEST_USER, "notion", row.tokenCiphertext)).toBe(true);
    gate.release();
    expect(await reason(pending)).toBe("changed");
    expect(await accounts.getMcp(TEST_USER, "notion")).toBeNull();
  });

  it("never overwrites a reconnect made during the refresh", async () => {
    const accounts = new FakeMcpAccounts();
    const app = fakeApp("notion");
    await seedConnection(accounts, app, "notion", { accessExpiresAt: Date.now() + 1000 });
    const gate = createBarrier();
    app.holdRefresh(() => gate.wait());
    const access = await openMcpAccess(deps(accounts, app));
    const pending = access.token(false);
    await gate.reached;
    const reconnect = await seedConnection(accounts, app, "notion");
    gate.release();
    expect(await reason(pending)).toBe("changed");
    const row = (await accounts.getMcp(TEST_USER, "notion"))!;
    expect(row).toMatchObject({ subject: reconnect.subject, tokenCiphertext: reconnect.sealed, status: "connected" });
  });

  it("marks the row for a reconnect, and sends nothing, when an earlier claim expired", async () => {
    const accounts = new FakeMcpAccounts();
    const app = fakeApp("notion");
    const seeded = await seedConnection(accounts, app, "notion", { accessExpiresAt: Date.now() - 1000 });
    const { row, bundle } = await bundleOf(accounts);
    const claimed = await sealBundle(TEST_KEY, TEST_USER, row.subject, {
      ...bundle!,
      claim: { id: crypto.randomUUID(), until: Date.now() - 1 },
    });
    await accounts.swapMcpCiphertext(TEST_USER, "notion", row.subject, seeded.sealed, claimed);
    const access = await openMcpAccess(deps(accounts, app));
    expect(await reason(access.token(false))).toBe("needs_reconnect");
    expect(app.refreshUses.size).toBe(0);
    expect((await accounts.getMcp(TEST_USER, "notion"))!.status).toBe("needs_reconnect");
  });

  it("does not store or use a late token after another request marked the expired claim", async () => {
    const accounts = new FakeMcpAccounts();
    const app = fakeApp("notion");
    await seedConnection(accounts, app, "notion", { accessExpiresAt: Date.now() + 1000 });
    let clock = Date.now();
    const gate = createBarrier();
    app.holdRefresh(() => gate.wait());
    const slow = await openMcpAccess(deps(accounts, app, { now: () => clock }));
    const pending = slow.token(false);
    await gate.reached;
    clock += 60_000;
    const later = await openMcpAccess(deps(accounts, app, { now: () => clock }));
    expect(await reason(later.token(false))).toBe("needs_reconnect");
    const marked = (await accounts.getMcp(TEST_USER, "notion"))!;
    expect(marked.status).toBe("needs_reconnect");
    gate.release();
    expect(await reason(pending)).toBe("changed");
    const after = (await accounts.getMcp(TEST_USER, "notion"))!;
    expect(after).toMatchObject({ status: "needs_reconnect", tokenCiphertext: marked.tokenCiphertext });
  });

  it("uses the new token when the store committed but its answer was lost", async () => {
    const accounts = new FakeMcpAccounts();
    const app = fakeApp("notion");
    await seedConnection(accounts, app, "notion", { accessExpiresAt: Date.now() + 1000 });
    const swap = accounts.swapMcpCiphertext.bind(accounts);
    let calls = 0;
    accounts.swapMcpCiphertext = async (...args) => {
      calls += 1;
      const done = await swap(...args);
      if (calls === 2) throw new Error("lost answer");
      return done;
    };
    const token = await (await openMcpAccess(deps(accounts, app))).token(false);
    const { row, bundle } = await bundleOf(accounts);
    expect(row.status).toBe("connected");
    expect(bundle!.accessToken).toBe(token);
  });

  it("does not use a committed token whose row a reconnect mark reached before the read-back", async () => {
    const accounts = new FakeMcpAccounts();
    const app = fakeApp("notion");
    await seedConnection(accounts, app, "notion", { accessExpiresAt: Date.now() + 1000 });
    const swap = accounts.swapMcpCiphertext.bind(accounts);
    let calls = 0;
    accounts.swapMcpCiphertext = async (...args) => {
      calls += 1;
      const done = await swap(...args);
      if (calls === 2) {
        await accounts.markMcpNeedsReconnect(TEST_USER, "notion", args[4]);
        throw new Error("lost answer");
      }
      return done;
    };
    expect(await reason((await openMcpAccess(deps(accounts, app))).token(false))).toBe("changed");
  });

  it.each([
    ["a timeout", () => new Response(null, { status: 504 })],
    ["invalid_grant", () => Response.json({ error: "invalid_grant" }, { status: 400 })],
    ["a body that fails the schema", () => Response.json({ access_token: "" })],
  ])("marks the row for a reconnect after %s, and never sends the old refresh token again", async (_name, answer) => {
    const accounts = new FakeMcpAccounts();
    const app = fakeApp("notion");
    const seeded = await seedConnection(accounts, app, "notion", { accessExpiresAt: Date.now() + 1000 });
    app.answerRefresh(answer);
    expect(await reason((await openMcpAccess(deps(accounts, app))).token(false))).toBe("needs_reconnect");
    expect((await accounts.getMcp(TEST_USER, "notion"))!.status).toBe("needs_reconnect");
    app.answerRefresh(null);
    expect(await reason(openMcpAccess(deps(accounts, app)))).toBe("needs_reconnect");
    expect(app.refreshUses.get(seeded.tokens.refresh_token!)).toBe(1);
  });

  it("gives the row back unchanged when Stop comes before the send", async () => {
    const accounts = new FakeMcpAccounts();
    const app = fakeApp("notion");
    const seeded = await seedConnection(accounts, app, "notion", { accessExpiresAt: Date.now() + 1000 });
    const controller = new AbortController();
    const access = await openMcpAccess(deps(accounts, app, { signal: controller.signal }));
    controller.abort();
    await expect(access.token(false)).rejects.toBeDefined();
    expect(app.refreshUses.size).toBe(0);
    expect((await accounts.getMcp(TEST_USER, "notion"))!).toMatchObject({ tokenCiphertext: seeded.sealed, status: "connected" });
  });

  it("refuses a row that does not open, a row in needs_reconnect and no row", async () => {
    const accounts = new FakeMcpAccounts();
    const app = fakeApp("notion");
    expect(await reason(openMcpAccess(deps(accounts, app)))).toBe("not_connected");
    const seeded = await seedConnection(accounts, app, "notion");
    expect(await reason(openMcpAccess(deps(accounts, app, { userId: "user-2" })))).toBe("not_connected");
    const row = accounts.rows.get(`${TEST_USER}:notion`)!;
    row.subject = "conn_00000000-0000-4000-8000-000000000000";
    expect(await reason(openMcpAccess(deps(accounts, app)))).toBe("needs_reconnect");
    expect(row.status).toBe("needs_reconnect");
    void seeded;
  });
});
