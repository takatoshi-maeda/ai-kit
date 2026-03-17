import { describe, expect, it } from "vitest";
import { PostgresPersistence } from "../../../src/agent/persistence/postgres.js";
import { createFakePostgresSql } from "../../helpers/fake-postgres.js";

describe("PostgresPersistence", () => {
  it("stores and reads conversations", async () => {
    const sql = createFakePostgresSql();
    const persistence = new PostgresPersistence({
      appName: "chat-app",
      sql,
    });

    await persistence.appendConversationTurn("session-1", {
      turnId: "turn-1",
      runId: "run-1",
      timestamp: "2026-03-17T00:00:00.000Z",
      userMessage: "Hello",
      assistantMessage: "Hi",
      status: "success",
      agentId: "chat-app",
      agentName: "Chat App",
    }, "Greeting");

    const conversation = await persistence.readConversation("session-1", "chat-app");
    expect(conversation).not.toBeNull();
    expect(conversation?.title).toBe("Greeting");
    expect(conversation?.agentName).toBe("Chat App");
    expect(conversation?.turns).toHaveLength(1);
    expect(sql.tableRows("conversations")).toHaveLength(1);
    expect(sql.tableRows("conversation_events")).toHaveLength(2);
  });

  it("keeps in-progress run state and summarizes usage", async () => {
    const sql = createFakePostgresSql();
    const persistence = new PostgresPersistence({
      appName: "chat-app",
      sql,
    });

    await persistence.appendRunState("session-1", {
      runId: "run-1",
      status: "running",
      startedAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:01:00.000Z",
      userMessage: "Pending",
      agentId: "chat-app",
    });
    await persistence.appendUsage(0.1, "usd");

    const summaries = await persistence.listConversationSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.status).toBe("progress");

    const periodSummary = await persistence.summarizeUsage("2025-03");
    expect(periodSummary).toEqual({
      period: "2025-03",
      cost: {
        totalUsd: 0,
        totalByCurrency: {},
      },
    });
  });

  it("lists conversations when postgres returns Date timestamps", async () => {
    const sql = createFakePostgresSql({ dateTimestamps: true });
    const persistence = new PostgresPersistence({
      appName: "chat-app",
      sql,
    });

    await persistence.appendConversationTurn("session-1", {
      turnId: "turn-1",
      runId: "run-1",
      timestamp: "2026-03-17T00:00:00.000Z",
      userMessage: "Hello",
      assistantMessage: "Hi",
      status: "success",
      agentId: "chat-app",
    });

    await persistence.appendUsage(0.1, "usd");

    const summaries = await persistence.listConversationSummaries();
    const usage = await persistence.summarizeUsage("2026-03");

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.updatedAt).toMatch(/^2026-03-\d{2}T/);
    expect(usage).toEqual({
      period: "2026-03",
      cost: {
        totalUsd: 0.1,
        totalByCurrency: { usd: 0.1 },
      },
    });
  });

  it("writes and reads idempotency records", async () => {
    const sql = createFakePostgresSql();
    const persistence = new PostgresPersistence({
      appName: "chat-app",
      sql,
    });

    await persistence.writeIdempotencyRecord({
      idempotencyKey: "key-1",
      sessionId: "session-1",
      runId: "run-1",
      status: "success",
      result: { ok: true },
      agentId: "chat-app",
      createdAt: "2026-03-17T00:00:00.000Z",
    });

    const record = await persistence.readIdempotencyRecord("key-1");
    expect(record).toEqual({
      idempotencyKey: "key-1",
      sessionId: "session-1",
      runId: "run-1",
      status: "success",
      result: { ok: true },
      agentId: "chat-app",
      createdAt: "2026-03-17T00:00:00.000Z",
    });
  });

  it("accepts returning ids as strings from postgres", async () => {
    const sql = createFakePostgresSql({ stringIds: true });
    const persistence = new PostgresPersistence({
      appName: "chat-app",
      sql,
    });

    await persistence.appendConversationTurn("session-1", {
      turnId: "turn-1",
      runId: "run-1",
      timestamp: "2026-03-17T00:00:00.000Z",
      userMessage: "Hello",
      assistantMessage: "Hi",
      status: "success",
      agentId: "chat-app",
    });

    const conversation = await persistence.readConversation("session-1", "chat-app");
    expect(conversation?.turns).toHaveLength(1);
  });
});
