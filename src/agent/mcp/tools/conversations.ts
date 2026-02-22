import { z } from "zod";
import type { McpPersistence } from "../persistence.js";

export const ConversationsListParamsSchema = z.object({
  limit: z.number().optional().describe("Maximum number of conversations to return"),
});

export const ConversationsGetParamsSchema = z.object({
  sessionId: z.string().optional().describe("The session ID of the conversation to retrieve"),
});

export const ConversationsDeleteParamsSchema = z.object({
  sessionId: z.string().optional().describe("The session ID of the conversation to delete"),
});

export async function handleConversationsList(
  persistence: McpPersistence,
  params: z.infer<typeof ConversationsListParamsSchema>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { sessions: Array<Record<string, unknown>> };
  isError: boolean;
}> {
  const summaries = await persistence.listConversationSummaries(params.limit);
  const sessions = summaries.map((summary) => ({
    sessionId: summary.sessionId,
    title: summary.title ?? null,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    status: summary.status,
    activeRunId: summary.activeRunId ?? null,
    activeUpdatedAt: summary.activeUpdatedAt ?? null,
    turnCount: summary.turnCount,
    latestUserMessage: summary.latestUserMessage ?? null,
  }));
  const payload = { sessions };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

export async function handleConversationsGet(
  persistence: McpPersistence,
  params: z.infer<typeof ConversationsGetParamsSchema>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  const sessionId = params.sessionId;
  const conversation = sessionId
    ? await persistence.readConversation(sessionId)
    : null;
  if (!conversation) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: "Conversation not found" }),
        },
      ],
      isError: true,
    };
  }
  const payload = formatConversationForWire(conversation);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

export async function handleConversationsDelete(
  persistence: McpPersistence,
  params: z.infer<typeof ConversationsDeleteParamsSchema>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { deleted: boolean };
  isError: boolean;
}> {
  const sessionId = params.sessionId;
  const deleted = sessionId ? await persistence.deleteConversation(sessionId) : false;
  const payload = { deleted };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
    isError: false,
  };
}

function formatConversationForWire(
  conversation: Awaited<ReturnType<McpPersistence["readConversation"]>> extends infer T
    ? Exclude<T, null>
    : never,
): Record<string, unknown> {
  const turns = conversation.turns.map((turn) => ({
    turnId: turn.turnId,
    runId: turn.runId,
    timestamp: turn.timestamp,
    userMessage: turn.userMessage,
    assistantMessage: turn.assistantMessage,
    status: turn.status,
    errorMessage: turn.errorMessage ?? null,
    timeline: turn.timeline ?? null,
    agentId: turn.agentId ?? null,
    agentName: turn.agentName ?? null,
  }));

  const inProgress = conversation.inProgress
    ? {
        runId: conversation.inProgress.runId,
        turnId: conversation.inProgress.turnId ?? null,
        startedAt: conversation.inProgress.startedAt,
        updatedAt: conversation.inProgress.updatedAt,
        userMessage: conversation.inProgress.userMessage ?? null,
        assistantMessage: conversation.inProgress.assistantMessage ?? null,
        timeline: conversation.inProgress.timeline ?? null,
        agentId: conversation.inProgress.agentId ?? null,
        agentName: conversation.inProgress.agentName ?? null,
      }
    : null;

  return {
    sessionId: conversation.sessionId,
    title: conversation.title ?? null,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    agentName: conversation.agentName ?? null,
    status: conversation.status,
    inProgress,
    turns,
  };
}
