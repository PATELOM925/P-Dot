import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareChatTurn } from "@/server/assistant/service";
import { RepositoryError, SchemaMissingError, createConversationRepository } from "@/server/db/conversations";
import { createDocumentRepository } from "@/server/db/documents";
import { createMemoryRepository } from "@/server/db/memories";
import { FakeQuota, FakeSpend, fakeDeps } from "../support/fakes";
import { sqlGateClient } from "../support/sql-gate-client";
import { startSqlGate, type SqlGate } from "../support/sql-gate";

/**
 * The repositories of decision 0012 against the real SQL: with every
 * migration, and without the resend migration, where they must fail closed
 * before any write.
 */
const RESEND_MIGRATION = "20261021020000_resend_idempotency.sql";
const HASH = "c".repeat(64);
const VECTOR = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));

describe("decision 0012 repositories with every migration", () => {
  let gate: SqlGate;
  beforeAll(async () => {
    gate = await startSqlGate({ defaults: "none" });
  });
  afterAll(async () => {
    await gate?.close();
  });

  it("stores a keyed conversation and message, finds them by the key, and claims and links the reply", async () => {
    const owner = await gate.createUser();
    const repo = createConversationRepository(sqlGateClient(gate, owner));
    const key = crypto.randomUUID();
    const conversation = await repo.createConversation(owner, "Plan", "work", { clientRequest: { id: key, hash: HASH } });
    const claimId = crypto.randomUUID();
    const question = await repo.insertMessage(owner, {
      id: crypto.randomUUID(),
      conversationId: conversation.id,
      role: "user",
      content: "Plan my week",
      clientRequest: { id: key, hash: HASH },
      replyClaimId: claimId,
    });

    // The message insert moves updated_at forward.
    expect(await repo.findConversationByClientRequest(owner, key)).toMatchObject({
      conversation: { id: conversation.id, title: "Plan", mode: "work" },
      hash: HASH,
    });
    expect(await repo.findMessageByClientRequest(owner, key)).toEqual({
      message: question,
      conversationId: conversation.id,
      hash: HASH,
    });
    expect(await repo.findMessageByClientRequest(owner, crypto.randomUUID())).toBeNull();

    expect(await repo.claimReply(question.id, 300)).toEqual({ outcome: "busy" });
    await repo.releaseReplyClaim(question.id, claimId);
    const claim = await repo.claimReply(question.id, 300);
    expect(claim.outcome).toBe("claimed");

    const replyId = crypto.randomUUID();
    await repo.insertMessage(owner, {
      id: replyId,
      conversationId: conversation.id,
      role: "assistant",
      content: "Here it is.",
      route: { model: "m", tier: "standard", reason: "everyday", fallback: false },
      replyTo: question.id,
    });
    expect(await repo.getMessage(owner, replyId)).toMatchObject({ id: replyId, role: "assistant" });
    expect(await repo.claimReply(question.id, 300)).toEqual({ outcome: "answered", replyId });

    const second = repo.insertMessage(owner, { conversationId: conversation.id, role: "assistant", content: "Again", replyTo: question.id });
    await expect(second).rejects.toBeInstanceOf(RepositoryError);
    await expect(second).rejects.not.toBeInstanceOf(SchemaMissingError);
    const duplicate = repo.insertMessage(owner, {
      conversationId: conversation.id,
      role: "user",
      content: "Plan my week",
      clientRequest: { id: key, hash: HASH },
    });
    await expect(duplicate).rejects.toBeInstanceOf(RepositoryError);
  });

  it("stores a keyed memory and finds it by the key for its owner only", async () => {
    const owner = await gate.createUser();
    const other = await gate.createUser();
    const key = crypto.randomUUID();
    const memory = await createMemoryRepository(sqlGateClient(gate, owner)).createMemory(
      owner,
      { mode: "personal", content: "Likes tea", status: "active", source: "user", sourceMessageId: null, clientRequest: { id: key, hash: HASH } },
      VECTOR,
    );
    expect(await createMemoryRepository(sqlGateClient(gate, owner)).findMemoryByClientRequest(owner, key)).toEqual({ memory, hash: HASH });
    expect(await createMemoryRepository(sqlGateClient(gate, other)).findMemoryByClientRequest(other, key)).toBeNull();
  });

  it("stores a keyed document, settles it with settle_document, and skips a failed one in the key lookup", async () => {
    const owner = await gate.createUser();
    const documents = createDocumentRepository(sqlGateClient(gate, owner));
    const key = crypto.randomUUID();
    const failed = await documents.createDocument(owner, {
      mode: "work",
      title: "Handbook",
      mediaType: "text/plain",
      charCount: 5,
      clientRequest: { id: key, hash: HASH },
    });
    expect(await documents.settleDocument(failed.id)).toBe("failed");
    expect(await documents.findDocumentByClientRequest(owner, key)).toBeNull();

    const document = await documents.createDocument(owner, {
      mode: "work",
      title: "Handbook",
      mediaType: "text/plain",
      charCount: 5,
      clientRequest: { id: key, hash: HASH },
    });
    expect(await documents.findDocumentByClientRequest(owner, key)).toEqual({ document, hash: HASH });
    await gate.as(
      { role: "authenticated", userId: owner },
      "insert into document_chunks (user_id, document_id, chunk_index, content, embedding) values ($1, $2, 0, 'c', $3)",
      [owner, document.id, `[${VECTOR.join(",")}]`],
    );
    expect(await documents.settleDocument(document.id)).toBe("ready");
    expect(await documents.settleDocument(crypto.randomUUID())).toBeNull();
  });
});

describe("decision 0012 code on a database without the resend migration", () => {
  let old: SqlGate;
  beforeAll(async () => {
    old = await startSqlGate({ defaults: "legacy", stopBefore: RESEND_MIGRATION });
  });
  afterAll(async () => {
    await old?.close();
  });

  const rows = async (table: string) =>
    (await old.admin<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;

  it("a keyed send and Retry reply fail with SchemaMissingError before quota, spend and any write", async () => {
    const owner = await old.createUser();
    const repo = createConversationRepository(sqlGateClient(old, owner));
    const quota = new FakeQuota();
    const spend = new FakeSpend();
    const { deps } = fakeDeps({ quota, spend });
    deps.repo = repo;

    const keyed = prepareChatTurn(deps, {
      userId: owner,
      requestId: "r1",
      request: { action: "send", message: "Plan my week", webSearch: false },
      requestKey: crypto.randomUUID(),
    });
    await expect(keyed).rejects.toBeInstanceOf(SchemaMissingError);

    const conversation = (
      await old.as<{ id: string }>({ role: "authenticated", userId: owner }, "insert into conversations (user_id, title) values ($1, 't') returning id", [owner])
    ).rows[0]!.id;
    await old.as(
      { role: "authenticated", userId: owner },
      "insert into messages (conversation_id, user_id, role, content) values ($1, $2, 'user', 'Hi')",
      [conversation, owner],
    );
    const before = await rows("messages");
    const retry = prepareChatTurn(deps, {
      userId: owner,
      requestId: "r2",
      request: { action: "retry", conversationId: conversation, webSearch: false },
    });
    await expect(retry).rejects.toBeInstanceOf(SchemaMissingError);

    expect(quota.calls).toBe(0);
    expect(spend.reservations).toHaveLength(0);
    expect(await rows("messages")).toBe(before);
  });

  it("a keyed memory or document fails at its lookup, and settle_document is missing", async () => {
    const owner = await old.createUser();
    const client = sqlGateClient(old, owner);
    await expect(createMemoryRepository(client).findMemoryByClientRequest(owner, crypto.randomUUID())).rejects.toBeInstanceOf(
      SchemaMissingError,
    );
    await expect(createDocumentRepository(client).findDocumentByClientRequest(owner, crypto.randomUUID())).rejects.toBeInstanceOf(
      SchemaMissingError,
    );
    await expect(createDocumentRepository(client).settleDocument(crypto.randomUUID())).rejects.toBeInstanceOf(SchemaMissingError);
    expect(await rows("memories")).toBe(0);
    expect(await rows("documents")).toBe(0);
  });
});
