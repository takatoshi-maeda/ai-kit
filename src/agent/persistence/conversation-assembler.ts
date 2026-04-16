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
  type: "turn";
  data: ConversationTurn;
  timestamp: string;
}

export function assembleConversation(
  sessionId: string,
  records: ConversationRecord[],
  options?: {
    title?: string;
    agentId?: string;
    agentName?: string;
    latestRunState?: RunState;
    createdAt?: string;
    updatedAt?: string;
  },
): Conversation {
  const turns: ConversationTurn[] = [];

  for (const record of records) {
    turns.push(record.data);
  }

  const latestRunState = options?.latestRunState;
  const firstTimestamp =
    options?.createdAt ??
    records[0]?.timestamp ??
    latestRunState?.startedAt ??
    new Date().toISOString();
  const lastRecordTimestamp = records[records.length - 1]?.timestamp ?? firstTimestamp;
  const lastStateOrRecordTimestamp = latestRunState
    ? [lastRecordTimestamp, latestRunState.updatedAt].sort((left, right) => left.localeCompare(right)).at(-1) ?? lastRecordTimestamp
    : lastRecordTimestamp;
  const lastTimestamp = options?.updatedAt && options.updatedAt.localeCompare(lastStateOrRecordTimestamp) > 0
    ? options.updatedAt
    : lastStateOrRecordTimestamp;
  const isInProgress = latestRunState !== undefined &&
    latestRunState.status !== "success" &&
    latestRunState.status !== "error" &&
    latestRunState.status !== "cancelled";

  const conversation: Conversation = {
    sessionId,
    title: options?.title,
    createdAt: firstTimestamp,
    updatedAt: lastTimestamp,
    agentId: options?.agentId,
    agentName: options?.agentName,
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
      metadata: latestRunState.metadata,
      agentId: latestRunState.agentId,
      agentName: latestRunState.agentName,
      runtime: latestRunState.runtime,
    };
  }

  conversation.lastRuntime =
    conversation.inProgress?.runtime ??
    conversation.turns[conversation.turns.length - 1]?.runtime;

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
