import { z } from "zod";
import type { McpPersistence } from "../persistence.js";
import { fromFileSystemAssetRef } from "../../public-assets/filesystem.js";

export const ConversationsListParamsSchema = z.object({
  limit: z.number().optional().describe("Maximum number of conversations to return"),
  agentId: z.string().optional().describe("Agent ID to scope conversation queries"),
});

export const ConversationsGetParamsSchema = z.object({
  sessionId: z.string().optional().describe("The session ID of the conversation to retrieve"),
  agentId: z.string().optional().describe("Agent ID to scope conversation queries"),
  _httpTransport: z
    .boolean()
    .optional()
    .describe("Internal flag set by HTTP bridge routes to render public URLs"),
  _publicBaseUrl: z
    .string()
    .optional()
    .describe("Internal absolute base URL for HTTP transport responses"),
});

export const ConversationsDeleteParamsSchema = z.object({
  sessionId: z.string().optional().describe("The session ID of the conversation to delete"),
  agentId: z.string().optional().describe("Agent ID to scope conversation queries"),
});

export async function handleConversationsList(
  persistence: McpPersistence,
  params: z.infer<typeof ConversationsListParamsSchema>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { sessions: Array<Record<string, unknown>> };
  isError: boolean;
}> {
  const summaries = await persistence.listConversationSummaries(params.limit, params.agentId);
  const sessions = summaries.map((summary) => ({
    sessionId: summary.sessionId,
    title: summary.title ?? null,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    agentId: summary.agentId ?? null,
    status: summary.status,
    activeRunId: summary.activeRunId ?? null,
    activeUpdatedAt: summary.activeUpdatedAt ?? null,
    turnCount: summary.turnCount,
    latestUserMessage: summary.latestUserMessage ?? null,
    latestUserContent: summary.latestUserContent ?? null,
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
  options?: { appName?: string; publicAssetsBasePath?: string },
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  const sessionId = params.sessionId;
  const conversation = sessionId
    ? await persistence.readConversation(sessionId, params.agentId)
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
  const payload = formatConversationForWire(conversation, {
    appName: options?.appName,
    usePublicUrl: params._httpTransport === true,
    publicAssetsBasePath: params._publicBaseUrl ?? options?.publicAssetsBasePath,
  });
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
  const deleted = sessionId ? await persistence.deleteConversation(sessionId, params.agentId) : false;
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
  options: {
    appName?: string;
    usePublicUrl: boolean;
    publicAssetsBasePath?: string;
  },
): Record<string, unknown> {
  const mapUserContent = (content: string | unknown[] | undefined): string | unknown[] | null => {
    if (!Array.isArray(content)) {
      return content ?? null;
    }
    if (!options.usePublicUrl) {
      return content;
    }
    return content.map((part) => {
      if (
        typeof part !== "object" ||
        part === null ||
        !("type" in part) ||
        (part as { type?: string }).type !== "image"
      ) {
        return part;
      }
      const imagePart = part as {
        source?: { type?: string; url?: string };
      };
      const source = imagePart.source;
      if (!source || source.type !== "url" || typeof source.url !== "string") {
        return part;
      }
      const publicUrl = toPublicAssetUrl(
        source.url,
        options.publicAssetsBasePath,
        options.appName,
      );
      if (!publicUrl) {
        return part;
      }
      return {
        ...imagePart,
        source: {
          ...source,
          url: publicUrl,
        },
      };
    });
  };
  const mapUserMessage = (message: string): string => {
    if (!options.usePublicUrl) {
      return message;
    }
    return message.replace(/\[image:url:([^\]]+)\]/g, (_full, rawUrl: string) => {
      const converted = toPublicAssetUrl(
        rawUrl,
        options.publicAssetsBasePath,
        options.appName,
      );
      return converted ? `[image:url:${converted}]` : `[image:url:${rawUrl}]`;
    });
  };

  const turns = conversation.turns.map((turn) => ({
    turnId: turn.turnId,
    runId: turn.runId,
    timestamp: turn.timestamp,
    userMessage: mapUserMessage(turn.userMessage),
    userContent: mapUserContent(turn.userContent),
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
        userMessage: conversation.inProgress.userMessage
          ? mapUserMessage(conversation.inProgress.userMessage)
          : null,
        userContent: mapUserContent(conversation.inProgress.userContent),
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
    agentId: conversation.agentId ?? null,
    agentName: conversation.agentName ?? null,
    status: conversation.status,
    inProgress,
    turns,
  };
}

function toPublicAssetUrl(
  storedPath: string,
  publicAssetsBasePath?: string,
  appName?: string,
): string | null {
  const basePath = (publicAssetsBasePath ?? "").replace(/\/+$/, "");
  if (!basePath) {
    return null;
  }
  if (/^uploads\/[^?#]+$/.test(storedPath)) {
    return `${basePath}/${storedPath}`;
  }

  const relativePath =
    fromFileSystemAssetRef(storedPath, appName) ??
    fromFileSystemAssetRef(storedPath);
  if (relativePath) {
    return `${basePath}/${relativePath}`;
  }

  if (/^storage\+[A-Za-z0-9+.-]+:/.test(storedPath)) {
    return `${basePath}/ref/${encodeURIComponent(storedPath)}`;
  }

  return null;
}
