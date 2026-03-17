import type {
  Conversation,
  ConversationSummary,
  ConversationTurn,
  RunState,
} from "./types.js";

export interface ConversationMetaRecord {
  title?: string;
  agentId?: string;
  agentName?: string;
}

export interface ConversationRecord {
  type: "turn" | "run_state" | "meta";
  data: ConversationTurn | RunState | ConversationMetaRecord;
  timestamp: string;
}

export function assembleConversation(
  sessionId: string,
  records: ConversationRecord[],
  agentId?: string,
): Conversation {
  const turns: ConversationTurn[] = [];
  let title: string | undefined;
  let scopedAgentId: string | undefined = agentId;
  let agentName: string | undefined;
  let latestRunState: RunState | undefined;

  for (const record of records) {
    if (record.type === "turn") {
      turns.push(record.data as ConversationTurn);
      continue;
    }
    if (record.type === "run_state") {
      latestRunState = record.data as RunState;
      continue;
    }
    const meta = record.data as ConversationMetaRecord;
    if (meta.title) title = meta.title;
    if (meta.agentId) scopedAgentId = meta.agentId;
    if (meta.agentName) agentName = meta.agentName;
  }

  const firstTimestamp = records[0]?.timestamp ?? new Date().toISOString();
  const lastTimestamp = records[records.length - 1]?.timestamp ?? firstTimestamp;
  const isInProgress = latestRunState !== undefined &&
    latestRunState.status !== "success" &&
    latestRunState.status !== "error" &&
    latestRunState.status !== "cancelled";

  const conversation: Conversation = {
    sessionId,
    title,
    createdAt: firstTimestamp,
    updatedAt: lastTimestamp,
    agentId: scopedAgentId,
    agentName,
    status: isInProgress ? "progress" : "idle",
    turns,
  };

  if (isInProgress && latestRunState) {
    conversation.inProgress = {
      runId: latestRunState.runId,
      turnId: latestRunState.turnId,
      startedAt: latestRunState.startedAt,
      updatedAt: latestRunState.updatedAt,
      userMessage: latestRunState.userMessage,
      userContent: latestRunState.userContent,
      assistantMessage: latestRunState.assistantMessage,
      timeline: latestRunState.timeline,
      agentId: latestRunState.agentId,
      agentName: latestRunState.agentName,
    };
  }

  return conversation;
}

export function summarizeConversation(conversation: Conversation): ConversationSummary {
  const latestUserMessage =
    conversation.turns.length > 0
      ? conversation.turns[conversation.turns.length - 1].userMessage
      : conversation.inProgress?.userMessage;
  const latestUserContent =
    conversation.turns.length > 0
      ? conversation.turns[conversation.turns.length - 1].userContent
      : conversation.inProgress?.userContent;

  return {
    sessionId: conversation.sessionId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    agentId: conversation.agentId,
    status: conversation.status,
    activeRunId: conversation.inProgress?.runId,
    activeUpdatedAt: conversation.inProgress?.updatedAt,
    turnCount: conversation.turns.length,
    latestUserMessage,
    latestUserContent,
  };
}
