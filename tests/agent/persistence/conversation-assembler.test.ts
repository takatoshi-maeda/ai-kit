import { describe, expect, it } from "vitest";
import {
  assembleConversation,
  summarizeConversation,
  type ConversationRecord,
} from "../../../src/agent/persistence/conversation-assembler.js";

describe("conversation-assembler", () => {
  it("assembles turns and in-progress run state into a conversation", () => {
    const records: ConversationRecord[] = [
      {
        type: "turn",
        data: {
          turnId: "turn-1",
          runId: "run-1",
          timestamp: "2026-03-17T00:00:01.000Z",
          userMessage: "Hello",
          assistantMessage: "Hi",
          status: "success",
          agentId: "front-desk",
        },
        timestamp: "2026-03-17T00:00:01.000Z",
      },
    ];

    const conversation = assembleConversation("session-1", records, {
      title: "Test Chat",
      agentId: "front-desk",
      agentName: "Front Desk",
      latestRunState: {
        runId: "run-2",
        turnId: "turn-2",
        status: "started",
        startedAt: "2026-03-17T00:00:02.000Z",
        updatedAt: "2026-03-17T00:00:03.000Z",
        userMessage: "Working...",
        metadata: {
          usageCostSession: {
            cumulativeUsageByModel: {
              "openai:gpt-5.4": {
                inputTokens: 1,
                outputTokens: 2,
                cachedInputTokens: 0,
                totalTokens: 3,
                inputCost: 4,
                outputCost: 5,
                cacheCost: 0,
                totalCost: 9,
              },
            },
          },
        },
        agentId: "front-desk",
        agentName: "Front Desk",
      },
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:03.000Z",
    });
    expect(conversation).toEqual({
      sessionId: "session-1",
      title: "Test Chat",
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:03.000Z",
      agentId: "front-desk",
      agentName: "Front Desk",
      status: "progress",
      inProgress: {
        runId: "run-2",
        turnId: "turn-2",
        startedAt: "2026-03-17T00:00:02.000Z",
        updatedAt: "2026-03-17T00:00:03.000Z",
        userMessage: "Working...",
        userContent: undefined,
        assistantMessage: undefined,
        timeline: undefined,
        metadata: {
          usageCostSession: {
            cumulativeUsageByModel: {
              "openai:gpt-5.4": {
                inputTokens: 1,
                outputTokens: 2,
                cachedInputTokens: 0,
                totalTokens: 3,
                inputCost: 4,
                outputCost: 5,
                cacheCost: 0,
                totalCost: 9,
              },
            },
          },
        },
        agentId: "front-desk",
        agentName: "Front Desk",
      },
      turns: [
        {
          turnId: "turn-1",
          runId: "run-1",
          timestamp: "2026-03-17T00:00:01.000Z",
          userMessage: "Hello",
          assistantMessage: "Hi",
          status: "success",
          agentId: "front-desk",
        },
      ],
    });

    expect(summarizeConversation(conversation)).toEqual({
      sessionId: "session-1",
      title: "Test Chat",
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:03.000Z",
      agentId: "front-desk",
      status: "progress",
      activeRunId: "run-2",
      activeUpdatedAt: "2026-03-17T00:00:03.000Z",
      turnCount: 1,
      latestUserMessage: "Hello",
      latestUserContent: undefined,
    });
  });
});
