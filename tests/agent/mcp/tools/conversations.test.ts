import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  handleConversationsList,
  handleConversationsGet,
  handleConversationsDelete,
} from "../../../../src/agent/mcp/tools/conversations.js";
import { JsonlMcpPersistence } from "../../../../src/agent/mcp/jsonl-persistence.js";
import { FileSystemStorage } from "../../../../src/storage/fs.js";
import type { ConversationTurn } from "../../../../src/agent/mcp/persistence.js";

let tmpDir: string;
let persistence: JsonlMcpPersistence;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-conv-"));
  persistence = new JsonlMcpPersistence(new FileSystemStorage(tmpDir));
});

function makeTurn(userMessage = "Hello"): ConversationTurn {
  return {
    turnId: "turn-1",
    runId: "run-1",
    timestamp: new Date().toISOString(),
    userMessage,
    assistantMessage: "Hi!",
    status: "success",
  };
}

describe("conversations tools", () => {
  describe("handleConversationsList", () => {
    it("returns empty list when no conversations", async () => {
      const result = await handleConversationsList(persistence, {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({ sessions: [] });
      expect(result.structuredContent).toEqual({ sessions: [] });
      expect(result.isError).toBe(false);
    });

    it("returns conversations", async () => {
      await persistence.appendConversationTurn("s1", makeTurn(), "Chat 1");
      await persistence.appendConversationTurn("s2", makeTurn("Bye"), "Chat 2");

      const result = await handleConversationsList(persistence, {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sessions).toHaveLength(2);
      expect(parsed.sessions[0]).toHaveProperty("sessionId");
      expect(parsed.sessions[0]).toHaveProperty("createdAt");
      expect(parsed.sessions[0]).toHaveProperty("updatedAt");
      expect(parsed.sessions[0]).toHaveProperty("activeRunId");
      expect(parsed.sessions[0]).toHaveProperty("activeUpdatedAt");
      expect(parsed.sessions[0]).toHaveProperty("turnCount");
      expect(parsed.sessions[0]).toHaveProperty("latestUserMessage");
    });
  });

  describe("handleConversationsGet", () => {
    it("returns conversation by session ID", async () => {
      await persistence.appendConversationTurn("s1", makeTurn(), "Test");

      const result = await handleConversationsGet(persistence, {
        sessionId: "s1",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sessionId).toBe("s1");
      expect(parsed.title).toBe("Test");
      expect(parsed.turns).toHaveLength(1);
      expect(parsed.turns[0]).toHaveProperty("turnId");
      expect(parsed.turns[0]).toHaveProperty("userMessage");
      expect(parsed.turns[0]).toHaveProperty("assistantMessage");
      expect(result.structuredContent).toEqual(parsed);
      expect(result.isError).toBe(false);
    });

    it("returns error for nonexistent conversation", async () => {
      const result = await handleConversationsGet(persistence, {
        sessionId: "nope",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("Conversation not found");
      expect(result.isError).toBe(true);
    });
  });

  describe("handleConversationsDelete", () => {
    it("deletes existing conversation", async () => {
      await persistence.appendConversationTurn("s1", makeTurn());

      const result = await handleConversationsDelete(persistence, {
        sessionId: "s1",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.deleted).toBe(true);
      expect(result.structuredContent).toEqual(parsed);
      expect(result.isError).toBe(false);

      // Verify deleted
      const get = await handleConversationsGet(persistence, {
        sessionId: "s1",
      });
      const getParsed = JSON.parse(get.content[0].text);
      expect(getParsed.error).toBe("Conversation not found");
    });

    it("returns false for nonexistent", async () => {
      const result = await handleConversationsDelete(persistence, {
        sessionId: "nope",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.deleted).toBe(false);
      expect(result.structuredContent).toEqual(parsed);
      expect(result.isError).toBe(false);
    });
  });
});
