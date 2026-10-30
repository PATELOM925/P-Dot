import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConversationRepository } from "@/server/db/conversations";
import { createDocumentRepository } from "@/server/db/documents";
import { createMemoryRepository } from "@/server/db/memories";
import { sqlGateClient } from "../support/sql-gate-client";
import { anon, errorCode, startSqlGate, user, type DefaultGrants, type SqlGate } from "../support/sql-gate";

/**
 * Database gate for decision 0012: request keys and fingerprints, one reply
 * for each user message, the reply claim, and the document status rule.
 * Every check runs with the older Supabase default grants and with none.
 */
const MODES: DefaultGrants[] = ["legacy", "none"];
const KEYED_TABLES = ["conversations", "messages", "memories", "documents"] as const;
type KeyedTable = (typeof KEYED_TABLES)[number];

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const KEY = "11111111-2222-4333-8444-555555555555";
const LEASE = 300;
const EMBEDDING = `[${[1, ...Array<number>(1023).fill(0)].join(",")}]`;

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const PERMISSION_DENIED = "42501";

let gate: SqlGate;

async function newConversation(owner: string): Promise<string> {
  const result = await gate.as<{ id: string }>(
    user(owner),
    "insert into conversations (user_id, title) values ($1, 't') returning id",
    [owner],
  );
  return result.rows[0]!.id;
}

async function newMessage(owner: string, conversation: string, role: "user" | "assistant", replyTo?: string): Promise<string> {
  const result = await gate.as<{ id: string }>(
    user(owner),
    "insert into messages (conversation_id, user_id, role, content, reply_to) values ($1, $2, $3, 'x', $4) returning id",
    [conversation, owner, role, replyTo ?? null],
  );
  return result.rows[0]!.id;
}

async function newDocument(owner: string, status = "processing"): Promise<string> {
  const result = await gate.admin<{ id: string }>(
    `insert into documents (user_id, mode, title, media_type, char_count, status)
     values ($1, 'personal', 'd', 'text/plain', 1, $2) returning id`,
    [owner, status],
  );
  return result.rows[0]!.id;
}

/** An insert into one keyed table, as `owner`, with a key and a fingerprint (either can be null). */
async function insertKeyed(table: KeyedTable, owner: string, key: string | null, hash: string | null, extra?: string) {
  switch (table) {
    case "conversations":
      return gate.as(user(owner), "insert into conversations (user_id, title, client_request_id, client_request_hash) values ($1, 't', $2, $3)", [
        owner,
        key,
        hash,
      ]);
    case "messages":
      return gate.as(
        user(owner),
        `insert into messages (conversation_id, user_id, role, content, client_request_id, client_request_hash)
         values ($4, $1, 'user', 'x', $2, $3)`,
        [owner, key, hash, extra ?? (await newConversation(owner))],
      );
    case "memories":
      return gate.as(
        user(owner),
        "insert into memories (user_id, mode, content, source, client_request_id, client_request_hash) values ($1, 'personal', 'x', 'user', $2, $3)",
        [owner, key, hash],
      );
    case "documents":
      return gate.as(
        user(owner),
        `insert into documents (user_id, mode, title, media_type, char_count, client_request_id, client_request_hash)
         values ($1, 'personal', 'd', 'text/plain', 1, $2, $3)`,
        [owner, key, hash],
      );
  }
}

type Claim = { outcome: string; claim_id: string | null; reply_id: string | null };

async function claim(owner: string, message: string, lease = LEASE): Promise<Claim> {
  const result = await gate.as<Claim>(user(owner), "select * from claim_reply($1, $2)", [message, lease]);
  return result.rows[0]!;
}

async function settle(owner: string, document: string): Promise<string | null> {
  const result = await gate.as<{ status: string | null }>(user(owner), "select settle_document($1) as status", [document]);
  return result.rows[0]!.status;
}

const insertChunk = (owner: string, document: string, index = 0) =>
  gate.as(
    user(owner),
    "insert into document_chunks (user_id, document_id, chunk_index, content, embedding) values ($1, $2, $3, 'c', $4)",
    [owner, document, index, EMBEDDING],
  );

describe.each(MODES)("resend keys and the reply claim with %s default grants", (defaults) => {
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    gate = await startSqlGate({ defaults });
    alice = await gate.createUser();
    bob = await gate.createUser();
  });

  afterAll(async () => {
    await gate?.close();
  });

  describe("request key and fingerprint", () => {
    it.each(KEYED_TABLES)("%s: one row for each key and user, and the same key for two users", async (table) => {
      const key = crypto.randomUUID();
      expect(await errorCode(() => insertKeyed(table, alice, key, HASH))).toBeNull();
      expect(await errorCode(() => insertKeyed(table, alice, key, HASH))).toBe(UNIQUE_VIOLATION);
      expect(await errorCode(() => insertKeyed(table, bob, key, OTHER_HASH))).toBeNull();
      expect(await errorCode(() => insertKeyed(table, alice, null, null))).toBeNull();
      expect(await errorCode(() => insertKeyed(table, alice, null, null))).toBeNull();
    });

    it.each(KEYED_TABLES)("%s: refuses a key without a fingerprint, a fingerprint without a key and a bad fingerprint", async (table) => {
      expect(await errorCode(() => insertKeyed(table, alice, crypto.randomUUID(), null))).toBe(CHECK_VIOLATION);
      expect(await errorCode(() => insertKeyed(table, alice, null, HASH))).toBe(CHECK_VIOLATION);
      expect(await errorCode(() => insertKeyed(table, alice, crypto.randomUUID(), "A".repeat(64)))).toBe(CHECK_VIOLATION);
      expect(await errorCode(() => insertKeyed(table, alice, crypto.randomUUID(), "a".repeat(63)))).toBe(CHECK_VIOLATION);
    });

    it("a failed document frees its key; a processing or ready one does not", async () => {
      const key = crypto.randomUUID();
      await insertKeyed("documents", alice, key, HASH);
      expect(await errorCode(() => insertKeyed("documents", alice, key, HASH))).toBe(UNIQUE_VIOLATION);
      await gate.as(user(alice), "update documents set status = 'ready' where client_request_id = $1", [key]);
      expect(await errorCode(() => insertKeyed("documents", alice, key, HASH))).toBe(UNIQUE_VIOLATION);
      await gate.as(user(alice), "update documents set status = 'failed' where client_request_id = $1", [key]);
      expect(await errorCode(() => insertKeyed("documents", alice, key, HASH))).toBeNull();
      const rows = await gate.admin<{ status: string }>(
        "select status from documents where user_id = $1 and client_request_id = $2 order by created_at",
        [alice, key],
      );
      expect(rows.rows.map((row) => row.status)).toEqual(["failed", "processing"]);
    });

    it("a memory and a document with a key write log rows without the key or the fingerprint", async () => {
      const key = crypto.randomUUID();
      await insertKeyed("memories", alice, key, HASH);
      await insertKeyed("documents", alice, key, HASH);
      const rows = await gate.admin<{ detail: string }>(
        "select detail::text as detail from action_log where user_id = $1 and event in ('memory_added', 'document_added')",
        [alice],
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      for (const row of rows.rows) {
        expect(row.detail).not.toContain(key);
        expect(row.detail).not.toContain(HASH);
      }
    });

    it("no API role can update a key, a fingerprint, a reply link or a claim", async () => {
      const columns = await gate.admin<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.column_privileges
          where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type = 'UPDATE'
            and column_name in ('client_request_id', 'client_request_hash', 'reply_to', 'reply_claim_id', 'reply_claimed_at')`,
      );
      expect(columns.rows).toEqual([]);
      const conversation = await newConversation(alice);
      const message = await newMessage(alice, conversation, "user");
      expect(
        await errorCode(() => gate.as(user(alice), "update messages set reply_claim_id = null where id = $1", [message])),
      ).toBe(PERMISSION_DENIED);
      expect(
        await errorCode(() => gate.as(user(alice), "update documents set client_request_id = null where user_id = $1", [alice])),
      ).toBe(PERMISSION_DENIED);
    });
  });

  describe("one reply for each user message", () => {
    it("refuses a second reply to one message", async () => {
      const conversation = await newConversation(alice);
      const question = await newMessage(alice, conversation, "user");
      await newMessage(alice, conversation, "assistant", question);
      expect(await errorCode(() => newMessage(alice, conversation, "assistant", question))).toBe(UNIQUE_VIOLATION);

    });

    it("gives the same error for a reply to another user's answered, unanswered or missing message", async () => {
      const conversation = await newConversation(alice);
      const theirConversation = await newConversation(bob);
      const answered = await newMessage(bob, theirConversation, "user");
      await newMessage(bob, theirConversation, "assistant", answered);
      const unanswered = await newMessage(bob, theirConversation, "user");
      const answers = [];
      for (const target of [answered, unanswered, "00000000-0000-4000-8000-000000000000"]) {
        try {
          await newMessage(alice, conversation, "assistant", target);
          answers.push("accepted");
        } catch (error) {
          answers.push(`${(error as { code?: string }).code}: ${(error as Error).message}`);
        }
      }
      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).toMatch(new RegExp(`^${FOREIGN_KEY_VIOLATION}: `));
    });

    it("deleting a conversation removes its messages and their replies", async () => {
      const conversation = await newConversation(alice);
      const question = await newMessage(alice, conversation, "user");
      await newMessage(alice, conversation, "assistant", question);
      await gate.as(user(alice), "delete from conversations where id = $1", [conversation]);
      const left = await gate.admin<{ n: number }>("select count(*)::int as n from messages where conversation_id = $1", [conversation]);
      expect(left.rows[0]!.n).toBe(0);
    });
  });

  describe("claim_reply and release_reply_claim", () => {
    it("claims once, is busy while the lease runs, and answers answered after a reply", async () => {
      const conversation = await newConversation(alice);
      const question = await newMessage(alice, conversation, "user");
      const first = await claim(alice, question);
      expect(first).toMatchObject({ outcome: "claimed", reply_id: null });
      expect(first.claim_id).toEqual(expect.any(String));
      expect(await claim(alice, question)).toEqual({ outcome: "busy", claim_id: null, reply_id: null });

      const reply = await newMessage(alice, conversation, "assistant", question);
      expect(await claim(alice, question)).toEqual({ outcome: "answered", claim_id: null, reply_id: reply });
    });

    it("a message inserted with a claim ID is busy from its insert time", async () => {
      const conversation = await newConversation(alice);
      const inserted = await gate.as<{ id: string }>(
        user(alice),
        "insert into messages (conversation_id, user_id, role, content, reply_claim_id) values ($1, $2, 'user', 'x', gen_random_uuid()) returning id",
        [conversation, alice],
      );
      const question = inserted.rows[0]!.id;
      expect((await claim(alice, question)).outcome).toBe("busy");
      await gate.admin("update messages set created_at = now() - interval '10 minutes' where id = $1", [question]);
      expect((await claim(alice, question)).outcome).toBe("claimed");
    });

    it("an ended lease can be claimed again, and only the holder can release a claim", async () => {
      const conversation = await newConversation(alice);
      const question = await newMessage(alice, conversation, "user");
      const first = await claim(alice, question);
      await gate.admin("update messages set reply_claimed_at = now() - interval '301 seconds' where id = $1", [question]);
      const second = await claim(alice, question);
      expect(second.outcome).toBe("claimed");
      expect(second.claim_id).not.toBe(first.claim_id);

      const release = (claimId: string | null) =>
        gate.as<{ ok: boolean }>(user(alice), "select release_reply_claim($1, $2) as ok", [question, claimId]);
      expect((await release(first.claim_id)).rows[0]!.ok).toBe(false);
      expect((await claim(alice, question)).outcome).toBe("busy");
      expect((await release(second.claim_id)).rows[0]!.ok).toBe(true);
      expect((await claim(alice, question)).outcome).toBe("claimed");
    });

    it("gives another user's message, an assistant message and a missing one the same not_found", async () => {
      const conversation = await newConversation(alice);
      const question = await newMessage(alice, conversation, "user");
      const reply = await newMessage(alice, conversation, "assistant", question);
      const notFound = { outcome: "not_found", claim_id: null, reply_id: null };
      expect(await claim(bob, question)).toEqual(notFound);
      expect(await claim(alice, reply)).toEqual(notFound);
      expect(await claim(alice, "00000000-0000-4000-8000-000000000000")).toEqual(notFound);
      const stored = await gate.admin("select reply_claim_id from messages where id = $1", [question]);
      expect(stored.rows).toEqual([{ reply_claim_id: null }]);

      const theirClaim = await claim(alice, question);
      const released = await gate.as<{ ok: boolean }>(user(bob), "select release_reply_claim($1, $2) as ok", [
        question,
        theirClaim.claim_id,
      ]);
      expect(released.rows[0]!.ok).toBe(false);
    });

    it("refuses a lease outside 60 to 900 seconds, a caller with no session, and anon", async () => {
      const question = await newMessage(alice, await newConversation(alice), "user");
      expect(await errorCode(() => claim(alice, question, 59))).toBe("22023");
      expect(await errorCode(() => claim(alice, question, 901))).toBe("22023");
      const noSession = { role: "authenticated" as const, userId: "" };
      expect(
        await errorCode(() =>
          gate.transactionAs(noSession, async (tx) => {
            await tx.query("select set_config('request.jwt.claims', '', true)");
            return tx.query("select * from claim_reply($1, 300)", [question]);
          }),
        ),
      ).toBe("28000");
      expect(await errorCode(() => gate.as(anon, "select * from claim_reply($1, 300)", [question]))).toBe(PERMISSION_DENIED);
      expect(
        await errorCode(() => gate.as(anon, "select release_reply_claim($1, $1)", [question])),
      ).toBe(PERMISSION_DENIED);
    });
  });

  describe("settle_document and the chunk rule", () => {
    it("chunks then a settle give ready; a settle then chunks refuses the chunks", async () => {
      const complete = await newDocument(alice);
      expect(await errorCode(() => insertChunk(alice, complete))).toBeNull();
      expect(await settle(alice, complete)).toBe("ready");

      const empty = await newDocument(alice);
      expect(await settle(alice, empty)).toBe("failed");
      expect(await errorCode(() => insertChunk(alice, empty))).toBe(CHECK_VIOLATION);
      const chunks = await gate.admin<{ n: number }>("select count(*)::int as n from document_chunks where document_id = $1", [empty]);
      expect(chunks.rows[0]!.n).toBe(0);
    });

    it("a chunk without a vector settles failed", async () => {
      const document = await newDocument(alice);
      await gate.as(user(alice), "insert into document_chunks (user_id, document_id, chunk_index, content) values ($1, $2, 0, 'c')", [
        alice,
        document,
      ]);
      expect(await settle(alice, document)).toBe("failed");
    });

    it("does not change a ready or failed document, and answers its status", async () => {
      const ready = await newDocument(alice, "ready");
      const failed = await newDocument(alice, "failed");
      expect(await settle(alice, ready)).toBe("ready");
      expect(await settle(alice, failed)).toBe("failed");
      const events = await gate.admin<{ n: number }>(
        "select count(*)::int as n from action_log where detail ->> 'documentId' in ($1, $2) and event in ('document_ready', 'document_failed')",
        [ready, failed],
      );
      expect(events.rows[0]!.n).toBe(0);
    });

    it("gives another user's document null and does not change it", async () => {
      const theirs = await newDocument(bob);
      expect(await settle(alice, theirs)).toBeNull();
      expect((await gate.admin("select status from documents where id = $1", [theirs])).rows).toEqual([{ status: "processing" }]);
    });

    it("refuses a chunk for another user with 42501, before it reads anything", async () => {
      const theirs = await newDocument(bob);
      const code = await errorCode(() =>
        gate.as(user(alice), "insert into document_chunks (user_id, document_id, chunk_index, content) values ($1, $2, 0, 'c')", [
          bob,
          theirs,
        ]),
      );
      expect(code).toBe(PERMISSION_DENIED);
    });

    it("gives the same error for another user's processing, ready and failed document and a missing one", async () => {
      const targets = [
        await newDocument(bob, "processing"),
        await newDocument(bob, "ready"),
        await newDocument(bob, "failed"),
        "00000000-0000-4000-8000-000000000000",
      ];
      const answers = [];
      for (const target of targets) {
        try {
          await insertChunk(alice, target);
          answers.push("accepted");
        } catch (error) {
          answers.push(`${(error as { code?: string }).code}: ${(error as Error).message}`);
        }
      }
      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).toMatch(/^23514: /);
    });

    it("refuses a chunk for an own ready or failed document", async () => {
      expect(await errorCode(() => insertChunk(alice, "00000000-0000-4000-8000-000000000000"))).toBe(CHECK_VIOLATION);
      const ready = await newDocument(alice, "ready");
      const failed = await newDocument(alice, "failed");
      expect(await errorCode(() => insertChunk(alice, ready))).toBe(CHECK_VIOLATION);
      expect(await errorCode(() => insertChunk(alice, failed))).toBe(CHECK_VIOLATION);
    });

    it("anon cannot settle a document", async () => {
      const document = await newDocument(alice);
      expect(await errorCode(() => gate.as(anon, "select settle_document($1)", [document]))).toBe(PERMISSION_DENIED);
    });
  });

  it("the new calls work with only the explicit grants", async () => {
    const owner = await gate.createUser();
    const conversation = (
      await gate.as<{ id: string }>(
        user(owner),
        `insert into conversations (id, user_id, title, client_request_id, client_request_hash)
         values (gen_random_uuid(), $1, 't', $2, $3) returning id`,
        [owner, KEY, HASH],
      )
    ).rows[0]!.id;
    const question = (
      await gate.as<{ id: string }>(
        user(owner),
        `insert into messages (id, conversation_id, user_id, role, content, client_request_id, client_request_hash, reply_claim_id)
         values (gen_random_uuid(), $1, $2, 'user', 'x', $3, $4, gen_random_uuid()) returning id`,
        [conversation, owner, KEY, HASH],
      )
    ).rows[0]!.id;
    const found = await gate.as(
      user(owner),
      "select id, client_request_hash, reply_claim_id from messages where user_id = $1 and client_request_id = $2 and role = 'user'",
      [owner, KEY],
    );
    expect(found.rows).toHaveLength(1);
    await gate.admin("update messages set created_at = now() - interval '10 minutes' where id = $1", [question]);
    expect((await claim(owner, question)).outcome).toBe("claimed");
    await newMessage(owner, conversation, "assistant", question);
    expect((await claim(owner, question)).outcome).toBe("answered");

    const document = (
      await gate.as<{ id: string }>(
        user(owner),
        `insert into documents (id, user_id, mode, title, media_type, char_count, client_request_id, client_request_hash)
         values (gen_random_uuid(), $1, 'personal', 'd', 'text/plain', 1, $2, $3) returning id`,
        [owner, KEY, HASH],
      )
    ).rows[0]!.id;
    await insertChunk(owner, document);
    expect(await settle(owner, document)).toBe("ready");
    await insertKeyed("memories", owner, KEY, HASH);
  });
});

describe("rows from before the resend migration", () => {
  const OWNER = "44444444-4444-4444-8444-444444444444";
  const CONVERSATION = "44444444-4444-4444-8444-000000000001";
  const QUESTION = "44444444-4444-4444-8444-000000000002";
  const DOCUMENT = "44444444-4444-4444-8444-000000000003";
  let old: SqlGate;

  beforeAll(async () => {
    old = await startSqlGate({
      defaults: "legacy",
      beforeMigration: {
        file: "20261021020000_resend_idempotency.sql",
        sql: `
          insert into auth.users (id) values ('${OWNER}');
          insert into conversations (id, user_id, title) values ('${CONVERSATION}', '${OWNER}', 'old');
          insert into messages (id, conversation_id, user_id, role, content, created_at)
            values ('${QUESTION}', '${CONVERSATION}', '${OWNER}', 'user', 'Older question', now() - interval '2 minutes');
          insert into messages (conversation_id, user_id, role, content, model, model_tier, route_reason, model_fallback, created_at)
            values ('${CONVERSATION}', '${OWNER}', 'assistant', 'Older reply', 'm', 'standard', 'default', false, now() - interval '1 minute');
          insert into memories (user_id, mode, content, source) values ('${OWNER}', 'personal', 'Older memory', 'user');
          insert into documents (id, user_id, mode, title, media_type, char_count)
            values ('${DOCUMENT}', '${OWNER}', 'personal', 'Older document', 'text/plain', 5);
          insert into document_chunks (user_id, document_id, chunk_index, content, embedding)
            values ('${OWNER}', '${DOCUMENT}', 0, 'chunk', '${EMBEDDING}');
        `,
      },
    });
  });

  afterAll(async () => {
    await old?.close();
  });

  it("keeps NULL in every new column", async () => {
    const messages = await old.admin(
      "select client_request_id, client_request_hash, reply_to, reply_claim_id, reply_claimed_at from messages where user_id = $1",
      [OWNER],
    );
    expect(messages.rows).toHaveLength(2);
    for (const row of messages.rows) expect(Object.values(row).every((value) => value === null)).toBe(true);
    for (const table of ["conversations", "memories", "documents"]) {
      const rows = await old.admin<{ n: number }>(
        `select count(*)::int as n from ${table} where user_id = $1 and (client_request_id is not null or client_request_hash is not null)`,
        [OWNER],
      );
      expect(rows.rows[0]!.n, table).toBe(0);
    }
  });

  it("reads the older rows through the app's repositories", async () => {
    const client = sqlGateClient(old, OWNER);
    const messages = await createConversationRepository(client).listRecentMessages(OWNER, CONVERSATION, 20);
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Older question"],
      ["assistant", "Older reply"],
    ]);
    expect(await createMemoryRepository(client).listMemories(OWNER, "personal", undefined, 10)).toHaveLength(1);
    expect(await createDocumentRepository(client).listDocuments(OWNER, "personal", 10)).toEqual([
      expect.objectContaining({ id: DOCUMENT, status: "processing" }),
    ]);
  });

  it("can claim an older message, which has no claim, and settles an older processing document", async () => {
    expect((await old.as<{ outcome: string }>(user(OWNER), "select * from claim_reply($1, 300)", [QUESTION])).rows[0]!.outcome).toBe(
      "claimed",
    );
    const settled = await old.as<{ status: string }>(user(OWNER), "select settle_document($1) as status", [DOCUMENT]);
    expect(settled.rows[0]!.status).toBe("ready");
  });
});
