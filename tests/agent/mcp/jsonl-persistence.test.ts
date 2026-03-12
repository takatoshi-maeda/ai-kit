import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { JsonlMcpPersistence } from "../../../src/agent/mcp/jsonl-persistence.js";
import { FileSystemStorage } from "../../../src/storage/fs.js";
import type { ConversationTurn, IdempotencyRecord } from "../../../src/agent/mcp/persistence.js";

let tmpDir: string;
let persistence: JsonlMcpPersistence;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-persist-"));
  const storage = new FileSystemStorage(tmpDir);
  persistence = new JsonlMcpPersistence(storage);
});

function makeTurn(overrides?: Partial<ConversationTurn>): ConversationTurn {
  return {
    turnId: "turn-1",
    runId: "run-1",
    timestamp: new Date().toISOString(),
    userMessage: "Hello",
    assistantMessage: "Hi there!",
    status: "success",
    ...overrides,
  };
}

describe("JsonlMcpPersistence", () => {
  describe("conversations", () => {
    it("returns null for nonexistent conversation", async () => {
      const result = await persistence.readConversation("nonexistent");
      expect(result).toBeNull();
    });

    it("appends and reads a conversation turn", async () => {
      const turn = makeTurn({ agentId: "front-desk" });
      await persistence.appendConversationTurn("sess-1", turn, "Test Chat");

      const conversation = await persistence.readConversation("sess-1", "front-desk");
      expect(conversation).not.toBeNull();
      expect(conversation!.sessionId).toBe("sess-1");
      expect(conversation!.title).toBe("Test Chat");
      expect(conversation!.agentId).toBe("front-desk");
      expect(conversation!.turns).toHaveLength(1);
      expect(conversation!.turns[0].userMessage).toBe("Hello");
      expect(conversation!.turns[0].assistantMessage).toBe("Hi there!");
      expect(conversation!.status).toBe("idle");
    });

    it("appends multiple turns", async () => {
      await persistence.appendConversationTurn("sess-1", makeTurn({ turnId: "t1", agentId: "front-desk" }), "Chat");
      await persistence.appendConversationTurn("sess-1", makeTurn({ turnId: "t2", userMessage: "Follow up", agentId: "front-desk" }));

      const conversation = await persistence.readConversation("sess-1", "front-desk");
      expect(conversation!.turns).toHaveLength(2);
      expect(conversation!.title).toBe("Chat");
    });

    it("tracks in-progress run state", async () => {
      const userContent = [
        { type: "image", source: { type: "url", url: "https://example.com/task.png" } },
      ] as const;
      await persistence.appendRunState("sess-1", {
        runId: "run-1",
        status: "started",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userMessage: "Working...",
        userContent: [...userContent],
        agentId: "front-desk",
      });

      const conversation = await persistence.readConversation("sess-1", "front-desk");
      expect(conversation!.status).toBe("progress");
      expect(conversation!.inProgress).toBeDefined();
      expect(conversation!.inProgress!.runId).toBe("run-1");
      expect(conversation!.inProgress!.userContent).toEqual(userContent);
      expect(conversation!.agentId).toBe("front-desk");
    });

    it("marks conversation idle after success run state", async () => {
      await persistence.appendRunState("sess-1", {
        runId: "run-1",
        status: "started",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        agentId: "front-desk",
      });
      await persistence.appendRunState("sess-1", {
        runId: "run-1",
        status: "success",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        agentId: "front-desk",
      });

      const conversation = await persistence.readConversation("sess-1", "front-desk");
      expect(conversation!.status).toBe("idle");
    });

    it("lists conversation summaries", async () => {
      const userContent = [
        { type: "text", text: "Hello from content parts" },
      ] as const;
      await persistence.appendConversationTurn(
        "sess-1",
        makeTurn({ agentId: "front-desk", userContent: [...userContent], userMessage: "Hello from content parts" }),
        "Chat 1",
      );
      await persistence.appendConversationTurn("sess-2", makeTurn({ agentId: "requirements-interviewer", userMessage: "Second" }), "Chat 2");

      const summaries = await persistence.listConversationSummaries();
      expect(summaries).toHaveLength(2);

      const ids = summaries.map((s) => s.sessionId);
      expect(ids).toContain("sess-1");
      expect(ids).toContain("sess-2");
      const first = summaries.find((summary) => summary.sessionId === "sess-1");
      expect(first?.latestUserContent).toEqual(userContent);
      expect(first?.agentId).toBe("front-desk");
    });

    it("filters summaries by agent ID", async () => {
      await persistence.appendConversationTurn("front-1", makeTurn({ agentId: "front-desk" }), "Front");
      await persistence.appendConversationTurn(
        "req-1",
        makeTurn({ agentId: "requirements-interviewer", userMessage: "Need details" }),
        "Req",
      );

      const summaries = await persistence.listConversationSummaries(undefined, "requirements-interviewer");
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.sessionId).toBe("req-1");
      expect(summaries[0]?.agentId).toBe("requirements-interviewer");
    });

    it("respects limit on summaries", async () => {
      await persistence.appendConversationTurn("a", makeTurn({ agentId: "front-desk" }), "A");
      await persistence.appendConversationTurn("b", makeTurn({ agentId: "front-desk" }), "B");
      await persistence.appendConversationTurn("c", makeTurn({ agentId: "front-desk" }), "C");

      const summaries = await persistence.listConversationSummaries(2);
      expect(summaries).toHaveLength(2);
    });

    it("deletes a conversation", async () => {
      await persistence.appendConversationTurn("sess-1", makeTurn({ agentId: "front-desk" }));

      const deleted = await persistence.deleteConversation("sess-1", "front-desk");
      expect(deleted).toBe(true);

      const result = await persistence.readConversation("sess-1", "front-desk");
      expect(result).toBeNull();
    });

    it("returns false when deleting nonexistent conversation", async () => {
      const deleted = await persistence.deleteConversation("nope");
      expect(deleted).toBe(false);
    });
  });

  describe("input message history", () => {
    it("appends and lists input messages", async () => {
      await persistence.appendInputMessageHistory("Hello");
      await persistence.appendInputMessageHistory("World");

      const history = await persistence.listInputMessageHistory();
      expect(history).toEqual(["Hello", "World"]);
    });

    it("returns empty array when no history", async () => {
      const history = await persistence.listInputMessageHistory();
      expect(history).toEqual([]);
    });
  });

  describe("usage", () => {
    it("appends and summarizes usage", async () => {
      await persistence.appendUsage(0.05, "usd", "sess-1", "run-1");
      await persistence.appendUsage(0.03, "usd", "sess-1", "run-2");

      const summary = await persistence.summarizeUsage();
      expect(summary).not.toBeNull();
      expect(summary!.cost.totalUsd).toBeCloseTo(0.08);
      expect(summary!.cost.totalByCurrency["usd"]).toBeCloseTo(0.08);
    });

    it("filters by period", async () => {
      // Manually write entries with different timestamps
      const storage = new FileSystemStorage(tmpDir);
      const jan = JSON.stringify({
        amount: 0.1,
        currency: "usd",
        timestamp: "2025-01-15T00:00:00Z",
      });
      const feb = JSON.stringify({
        amount: 0.2,
        currency: "usd",
        timestamp: "2025-02-15T00:00:00Z",
      });
      await storage.appendText("usage.jsonl", jan + "\n" + feb + "\n");

      const summary = await persistence.summarizeUsage("2025-02");
      expect(summary!.cost.totalUsd).toBeCloseTo(0.2);
      expect(summary!.period).toBe("2025-02");
    });

    it("returns null when no usage data", async () => {
      const summary = await persistence.summarizeUsage();
      expect(summary).toBeNull();
    });
  });

  describe("idempotency", () => {
    it("writes and reads idempotency record", async () => {
      const record: IdempotencyRecord = {
        idempotencyKey: "key-1",
        sessionId: "sess-1",
        runId: "run-1",
        status: "success",
        result: { message: "done" },
        createdAt: new Date().toISOString(),
      };

      await persistence.writeIdempotencyRecord(record);
      const read = await persistence.readIdempotencyRecord("key-1");

      expect(read).not.toBeNull();
      expect(read!.idempotencyKey).toBe("key-1");
      expect(read!.result).toEqual({ message: "done" });
    });

    it("returns null for nonexistent record", async () => {
      const result = await persistence.readIdempotencyRecord("nope");
      expect(result).toBeNull();
    });
  });

  describe("health check", () => {
    it("returns ok when storage is healthy", async () => {
      const result = await persistence.checkHealth();
      expect(result.ok).toBe(true);
    });
  });
});
