import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { FileSystemStorage } from "../../../src/storage/fs.js";
import { FilesystemPersistence } from "../../../src/agent/persistence/filesystem.js";
import { SupabasePersistence } from "../../../src/agent/persistence/supabase.js";
import type {
  AgentPersistence,
  Conversation,
  ConversationSummary,
  IdempotencyRecord,
  McpUsageSummary,
} from "../../../src/agent/persistence/types.js";
import { createFakeSupabaseClient } from "../../helpers/fake-supabase.js";

describe("SupabasePersistence", () => {
  it("matches the filesystem persistence contract for core reads", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ai-kit-supabase-contract-"));
    const filesystem = new FilesystemPersistence(new FileSystemStorage(tmpDir));
    const supabase = new SupabasePersistence({
      appName: "chat-app",
      userId: "anonymous",
      client: createFakeSupabaseClient(),
    });

    const filesystemResult = await exercisePersistence(filesystem);
    const supabaseResult = await exercisePersistence(supabase);

    expect(supabaseResult).toEqual(filesystemResult);
  });

  it("reports supabase health failures with the driver name", async () => {
    const client = createFakeSupabaseClient();
    const persistence = new SupabasePersistence({
      appName: "chat-app",
      userId: "anonymous",
      client,
    });

    client.failNext("database unavailable");

    await expect(persistence.checkHealth()).resolves.toEqual({
      ok: false,
      driver: "supabase",
      error: "database unavailable",
    });
  });
});

async function exercisePersistence(persistence: AgentPersistence): Promise<{
  conversation: Conversation | null;
  summaries: ConversationSummary[];
  inputHistory: string[];
  usage: McpUsageSummary | null;
  idempotency: IdempotencyRecord | null;
}> {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-03-17T00:00:00.000Z"));
    await persistence.appendRunState("sess-1", {
      runId: "run-1",
      turnId: "turn-1",
      status: "started",
      startedAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
      userMessage: "hello",
      userContent: [{ type: "text", text: "hello" }],
      assistantMessage: "",
      agentId: "agent-a",
      agentName: "Agent A",
    });
    await persistence.appendInputMessageHistory("hello", "sess-1", "run-1");
    await persistence.appendUsage(1.5, "usd", "sess-1", "run-1");

    vi.setSystemTime(new Date("2026-03-17T00:01:00.000Z"));
    await persistence.appendConversationTurn(
      "sess-1",
      {
        turnId: "turn-1",
        runId: "run-1",
        timestamp: "2026-03-17T00:00:59.000Z",
        userMessage: "hello",
        userContent: [
          { type: "text", text: "hello" },
          { type: "image", source: { type: "url", url: "storage+file:///chat-app/public/uploads/2026/03/17/sess-1/file.png" } },
        ],
        assistantMessage: "hi",
        status: "success",
        agentId: "agent-a",
        agentName: "Agent A",
      },
      "Greeting",
    );

    vi.setSystemTime(new Date("2026-03-17T00:02:00.000Z"));
    await persistence.appendRunState("sess-1", {
      runId: "run-1",
      turnId: "turn-1",
      status: "success",
      startedAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:02:00.000Z",
      userMessage: "hello",
      assistantMessage: "hi",
      agentId: "agent-a",
      agentName: "Agent A",
    });

    vi.setSystemTime(new Date("2026-03-18T00:00:00.000Z"));
    await persistence.appendConversationTurn(
      "sess-2",
      {
        turnId: "turn-2",
        runId: "run-2",
        timestamp: "2026-03-18T00:00:00.000Z",
        userMessage: "later",
        assistantMessage: "done",
        status: "success",
        agentId: "agent-b",
        agentName: "Agent B",
      },
      "Later",
    );
    await persistence.appendUsage(250, "jpy", "sess-2", "run-2");
    await persistence.appendInputMessageHistory("later", "sess-2", "run-2");

    await persistence.writeIdempotencyRecord({
      userId: "anonymous",
      idempotencyKey: "idem-1",
      sessionId: "sess-1",
      runId: "run-1",
      status: "success",
      result: { ok: true },
      agentId: "agent-a",
      createdAt: "2026-03-17T00:02:01.000Z",
    });

    return {
      conversation: await persistence.readConversation("sess-1", "agent-a"),
      summaries: await persistence.listConversationSummaries(),
      inputHistory: await persistence.listInputMessageHistory(),
      usage: await persistence.summarizeUsage(),
      idempotency: await persistence.readIdempotencyRecord("idem-1"),
    };
  } finally {
    vi.useRealTimers();
  }
}
