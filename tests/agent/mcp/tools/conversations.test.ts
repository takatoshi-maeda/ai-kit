import { describe, it, expect, beforeEach, vi } from "vitest";
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
      await persistence.appendConversationTurn("s1", { ...makeTurn(), agentId: "front-desk" }, "Chat 1");
      await persistence.appendConversationTurn(
        "s2",
        {
          ...makeTurn("Bye"),
          agentId: "requirements-interviewer",
          userContent: [
            { type: "image", source: { type: "url", url: "https://example.com/bye.png" } },
            { type: "text", text: "Bye" },
          ],
        },
        "Chat 2",
      );

      const result = await handleConversationsList(persistence, {});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sessions).toHaveLength(2);
      expect(parsed.sessions[0]).toHaveProperty("sessionId");
      expect(parsed.sessions[0]).toHaveProperty("agentId");
      expect(parsed.sessions[0]).toHaveProperty("createdAt");
      expect(parsed.sessions[0]).toHaveProperty("updatedAt");
      expect(parsed.sessions[0]).toHaveProperty("activeRunId");
      expect(parsed.sessions[0]).toHaveProperty("activeUpdatedAt");
      expect(parsed.sessions[0]).toHaveProperty("turnCount");
      expect(parsed.sessions[0]).toHaveProperty("latestUserMessage");
      expect(parsed.sessions[0]).toHaveProperty("latestUserContent");
    });

    it("returns sessions ordered by updatedAt descending", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-03-04T10:00:00Z"));
        await persistence.appendConversationTurn("s1", { ...makeTurn(), agentId: "front-desk" }, "Chat 1");

        vi.setSystemTime(new Date("2026-03-04T10:05:00Z"));
        await persistence.appendConversationTurn("s2", { ...makeTurn("Later"), agentId: "front-desk" }, "Chat 2");

        vi.setSystemTime(new Date("2026-03-04T10:10:00Z"));
        await persistence.appendConversationTurn(
          "s1",
          { ...makeTurn("Newest"), turnId: "turn-2", runId: "run-2", agentId: "front-desk" },
        );

        const result = await handleConversationsList(persistence, {});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual(["s1", "s2"]);
        expect(parsed.sessions[0].updatedAt).toBe("2026-03-04T10:10:00.000Z");
        expect(parsed.sessions[1].updatedAt).toBe("2026-03-04T10:05:00.000Z");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("handleConversationsGet", () => {
    it("returns conversation by session ID", async () => {
      const userContent = [
        { type: "image", source: { type: "url", url: "uploads/2026/03/04/s1/test.png" } },
      ] as const;
      await persistence.appendConversationTurn(
        "s1",
        { ...makeTurn(), agentId: "front-desk", userContent: [...userContent] },
        "Test",
      );

      const result = await handleConversationsGet(persistence, {
        sessionId: "s1",
        agentId: "front-desk",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sessionId).toBe("s1");
      expect(parsed.agentId).toBe("front-desk");
      expect(parsed.title).toBe("Test");
      expect(parsed.turns).toHaveLength(1);
      expect(parsed.turns[0]).toHaveProperty("turnId");
      expect(parsed.turns[0]).toHaveProperty("userMessage");
      expect(parsed.turns[0]).toHaveProperty("userContent");
      expect(parsed.turns[0]).toHaveProperty("assistantMessage");
      expect(parsed.turns[0].userContent).toEqual(userContent);
      expect(result.structuredContent).toEqual(parsed);
      expect(result.isError).toBe(false);
    });

    it("converts stored image paths to public URLs when called from HTTP transport", async () => {
      const userContent = [
        { type: "image", source: { type: "url", url: "uploads/2026/03/04/s1/test.png" } },
      ] as const;
      await persistence.appendConversationTurn(
        "s1",
        {
          ...makeTurn(),
          agentId: "front-desk",
          userMessage: "[image:url:uploads/2026/03/04/s1/test.png] check",
          userContent: [...userContent],
        },
        "Test",
      );

      const result = await handleConversationsGet(
        persistence,
        {
          sessionId: "s1",
          agentId: "front-desk",
          _httpTransport: true,
          _publicBaseUrl: "http://127.0.0.1:3290/api/mcp/codefleet/public",
        },
        { publicAssetsBasePath: "/api/mcp/codefleet/public" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.turns[0].userContent).toEqual([
        {
          type: "image",
          source: {
            type: "url",
            url: "http://127.0.0.1:3290/api/mcp/codefleet/public/uploads/2026/03/04/s1/test.png",
          },
        },
      ]);
      expect(parsed.turns[0].userMessage).toBe(
        "[image:url:http://127.0.0.1:3290/api/mcp/codefleet/public/uploads/2026/03/04/s1/test.png] check",
      );
    });

    it("converts in-progress stored image paths to public URLs when called from HTTP transport", async () => {
      const userContent = [
        { type: "image", source: { type: "url", url: "uploads/2026/03/04/s1/in-progress.png" } },
      ] as const;
      await persistence.appendRunState("s1", {
        runId: "run-1",
        turnId: "turn-1",
        status: "started",
        startedAt: "2026-03-04T00:00:00.000Z",
        updatedAt: "2026-03-04T00:01:00.000Z",
        userMessage: "[image:url:uploads/2026/03/04/s1/in-progress.png] check",
        userContent: [...userContent],
        agentId: "front-desk",
      });

      const result = await handleConversationsGet(
        persistence,
        {
          sessionId: "s1",
          agentId: "front-desk",
          _httpTransport: true,
          _publicBaseUrl: "http://127.0.0.1:3290/api/mcp/codefleet/public",
        },
        { publicAssetsBasePath: "/api/mcp/codefleet/public" },
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.inProgress.userContent).toEqual([
        {
          type: "image",
          source: {
            type: "url",
            url: "http://127.0.0.1:3290/api/mcp/codefleet/public/uploads/2026/03/04/s1/in-progress.png",
          },
        },
      ]);
      expect(parsed.inProgress.userMessage).toBe(
        "[image:url:http://127.0.0.1:3290/api/mcp/codefleet/public/uploads/2026/03/04/s1/in-progress.png] check",
      );
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
      await persistence.appendConversationTurn("s1", { ...makeTurn(), agentId: "front-desk" });

      const result = await handleConversationsDelete(persistence, {
        sessionId: "s1",
        agentId: "front-desk",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.deleted).toBe(true);
      expect(result.structuredContent).toEqual(parsed);
      expect(result.isError).toBe(false);

      // Verify deleted
      const get = await handleConversationsGet(persistence, {
        sessionId: "s1",
        agentId: "front-desk",
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
