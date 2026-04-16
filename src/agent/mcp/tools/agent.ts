import { z } from "zod";
import type { AuthContext } from "../../../auth/index.js";
import type { AgentRegistry } from "../agent-registry.js";
import type { McpPersistence, ConversationTurn, TimelineItem } from "../persistence.js";
import { AgentContextImpl } from "../../context.js";
import { InMemoryHistory } from "../../conversation/memory-history.js";
import {
  FileSystemPublicAssetStorage,
  toFileSystemAssetRef,
} from "../../public-assets/filesystem.js";
import type { PublicAssetStorage } from "../../public-assets/storage.js";
import type { LLMStreamEvent } from "../../../types/stream-events.js";
import type { ContentPart } from "../../../types/llm.js";
import {
  appendUsageToSerializedUsageCostSessionState,
  type SerializedUsageCostSessionState,
} from "../../../llm/costs.js";
import type {
  AgentRuntimePolicy,
  AgentRuntimeSettings,
  ResolvedAgentRuntime,
} from "../../../types/runtime.js";
import { resolveAgentRuntime } from "../runtime.js";

const ImageSourceSchema = z.union([
  z.object({
    type: z.literal("base64"),
    mediaType: z.string(),
    data: z.string(),
  }),
  z.object({
    type: z.literal("url"),
    url: z.string(),
  }),
]);

const FileSourceSchema = z.union([
  z.object({
    type: z.literal("asset-ref"),
    assetRef: z.string(),
  }),
  z.object({
    type: z.literal("url"),
    url: z.string(),
  }),
  z.object({
    type: z.literal("base64"),
    mediaType: z.string(),
    data: z.string(),
  }),
]);

const ContentPartSchema = z.union([
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    source: ImageSourceSchema,
  }),
  z.object({
    type: z.literal("file"),
    file: z.object({
      name: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number(),
      source: FileSourceSchema,
    }),
  }),
  z.object({
    type: z.literal("audio"),
    data: z.string(),
    format: z.string(),
  }),
]);

const ContentPartArraySchema = z.array(ContentPartSchema);

const UserInputSchema = z.union([z.string(), ContentPartArraySchema]);
const RuntimeSchema = z.object({
  model: z.string().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  verbosity: z.enum(["low", "medium", "high"]).optional(),
});

/** agent.run ツールの入力パラメータ */
export const AgentRunParamsSchema = z.object({
  message: z
    .string()
    .optional()
    .describe("The user message to send to the agent (legacy string input)"),
  input: UserInputSchema
    .optional()
    .describe("The user input to send to the agent (string or multimodal content parts)"),
  idempotencyKey: z.string().optional().describe("Idempotency key for deduplication"),
  sessionId: z.string().optional().describe("Session ID for conversation continuity"),
  title: z.string().optional().describe("Title for the conversation"),
  runtime: RuntimeSchema.optional().describe("Runtime LLM overrides for this run"),
  params: z.record(z.unknown()).optional().describe("Additional parameters for the agent"),
  agentId: z.string().optional().describe("Agent ID to use. Defaults to the default agent"),
  stream: z.boolean().optional().describe("Enable streaming notifications"),
  notificationToken: z.string().optional().describe("Token for stream notifications"),
});

export type AgentRunParams = z.infer<typeof AgentRunParamsSchema>;

/** agent.run ツールの戻り値 */
export interface AgentRunResult {
  sessionId: string;
  runId: string;
  turnId: string;
  status: "success" | "error" | "cancelled";
  responseId?: string;
  message: string;
  agentId?: string;
  idempotencyKey?: string;
  errorMessage?: string;
  runtime?: ResolvedAgentRuntime;
}

/** MCP ストリーム通知イベント */
export type McpStreamNotification =
  | { type: "agent.change_state.started"; sessionId: string; runId: string; agentId?: string; agentName?: string }
  | { type: "agent.reasoning_summary_delta"; delta: string }
  | {
      type: "agent.output_item.added";
      itemId: string;
      item: Record<string, unknown>;
      content_type: "artifact";
    }
  | {
      type: "agent.artifact_delta";
      itemId: string;
      delta: string;
    }
  | {
      type: "agent.output_item.done";
      itemId: string;
      item: Record<string, unknown>;
      content_type: "artifact";
    }
  | {
      type: "agent.tool_call";
      summary: string;
      description?: string;
      toolCallId?: string;
      arguments?: Record<string, unknown>;
    }
  | { type: "agent.tool_call_finish"; summary: string; toolCallId?: string; status: "completed" | "failed"; errorMessage?: string }
  | { type: "agent.text_delta"; delta: string }
  | { type: "agent.text_result"; summary?: string; description?: string; responseId?: string }
  | { type: "agent.result"; responseId?: string; item?: Record<string, unknown> }
  | { type: "agent.cumulative_cost"; amount: number }
  | { type: "agent.change_state.finished"; sessionId: string; runId: string; agentId?: string }
  | { type: "agent.change_state.error"; sessionId: string; runId: string; agentId?: string }
  | { type: "agent.change_state.cancelled"; sessionId: string; runId: string; agentId?: string };

export interface AgentToolDeps {
  registry: AgentRegistry;
  persistence: McpPersistence;
  authContext?: AuthContext;
  sendNotification?: (method: string, params: Record<string, unknown>) => Promise<void>;
  appName?: string;
  publicAssetStorage?: PublicAssetStorage;
  publicAssetsDir?: string;
  publicAssetsBasePath?: string;
}

const MAX_BASE64_IMAGE_BYTES_PER_TURN = 2 * 1024 * 1024;
const MAX_BASE64_FILE_BYTES_PER_TURN = 25 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES_FOR_INLINE_LLM = 256 * 1024;
const USAGE_COST_SESSION_METADATA_KEY = "usageCostSession";

const IMAGE_MEDIA_TYPE_TO_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export async function handleAgentList(
  deps: AgentToolDeps,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}> {
  const rawPayload = deps.registry.listPayload();
  const payload = {
    defaultAgentId: rawPayload.defaultAgentId,
    agents: rawPayload.agents.map((agent) => ({
      agentId: agent.agentId,
      description: agent.description ?? null,
      runtimePolicy: toRuntimePolicyWireValue(agent.runtimePolicy),
    })),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

export async function handleAgentRun(
  deps: AgentToolDeps,
  params: AgentRunParams,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}> {
  const {
    message,
    input,
    idempotencyKey,
    sessionId: requestedSessionId,
    title,
    runtime: requestedRuntime,
    params: agentParams,
    agentId: requestedAgentId,
    stream: enableStream,
  } = params;

  const agentId = deps.registry.resolveAgentId(requestedAgentId);
  const sessionId = requestedSessionId ?? crypto.randomUUID();
  const runId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const resolvedUserInput = resolveUserInput(input, message);
  const publicAssetsBasePath =
    deps.publicAssetsBasePath ??
    (deps.appName
      ? `/api/mcp/${encodeURIComponent(deps.appName)}/public`
      : `/api/mcp/${encodeURIComponent(agentId)}/public`);

  if (resolvedUserInput === undefined) {
    throw new Error("Either message or input must be provided");
  }

  const normalized = await normalizeUserInputForPersistence(
    resolvedUserInput,
    {
      appName: deps.appName,
      agentId,
      sessionId,
      publicAssetStorage: deps.publicAssetStorage,
      publicAssetsDir: deps.publicAssetsDir,
    },
  );
  const userInput = normalized.input;
  const userMessagePreview = toUserMessagePreview(normalized.input);
  // Persist internal asset refs while resolving local/public inputs to values
  // that upstream LLM APIs can actually fetch.
  const llmInput = await normalizeUserInputForLlm(userInput, {
    appName: deps.appName,
    publicAssetStorage: deps.publicAssetStorage,
    publicAssetsDir: deps.publicAssetsDir,
    publicAssetsBasePath,
  });

  // Check idempotency
  if (idempotencyKey) {
    const existing = await deps.persistence.readIdempotencyRecord(
      idempotencyKey,
      sessionId,
      agentId,
    );
    if (existing) {
      const payload = toAgentRunWireResult(
        existing.result as Partial<AgentRunResult> & Record<string, unknown>,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload, null, 2),
          },
        ],
        structuredContent: payload,
        isError: payload.status === "error",
      };
    }
  }

  // Record run state as started
  const entry = deps.registry.get(agentId);
  const resolvedRuntime = resolveAgentRuntime(
    entry.runtimePolicy,
    requestedRuntime,
  );
  const startedAt = new Date().toISOString();
  const runTimeline: TimelineItem[] = [];
  const toolCallState = new Map<string, { index: number; argumentsText: string }>();
  let partialAssistantMessage = "";
  await deps.persistence.appendRunState(sessionId, {
    runId,
    turnId,
    status: "started",
    startedAt,
    updatedAt: startedAt,
    userMessage: userMessagePreview,
    userContent: userInput,
    agentId,
    runtime: resolvedRuntime,
  });

  // Send start notification
  if (enableStream && deps.sendNotification) {
    await deps.sendNotification("agent/stream-response", {
      type: "agent.change_state.started",
      sessionId,
      runId,
      agentId,
    });
  }

  // Record input message
  await deps.persistence.appendInputMessageHistory(userMessagePreview, sessionId, runId);

  // Create agent context and run
  const existingConversation = await deps.persistence.readConversation(sessionId, agentId);
  const persistedPreviousResponseId = findLatestResponseId(existingConversation?.turns ?? []);
  const history = new InMemoryHistory();
  const context = new AgentContextImpl({
    history,
    sessionId,
    auth: deps.authContext,
    selectedAgentName: agentId,
  });
  const agent = entry.create(context, agentParams, resolvedRuntime);
  const provider = resolveAgentProvider(agent);
  const model = resolveAgentModel(agent);
  if (provider !== "openai") {
    await hydrateHistoryFromPersistence(deps.persistence, history, sessionId, agentId);
  }
  const persistedUsageCostSession = existingConversation?.inProgress?.metadata?.usageCostSession;
  if (persistedUsageCostSession) {
    context.metadata.set(USAGE_COST_SESSION_METADATA_KEY, persistedUsageCostSession);
  }
  if (provider === "openai" && persistedPreviousResponseId) {
    context.metadata.set("previousResponseId", persistedPreviousResponseId);
  }

  let result: AgentRunResult;

  try {
    if (enableStream && deps.sendNotification) {
      // Run with streaming notifications
      const agentStream = agent.stream(llmInput);
      let agentResult: Awaited<typeof agentStream.result>;
      try {
        for await (const event of agentStream) {
          if (event.type === "response.completed" && provider && model) {
            const nextUsageCostSession = appendUsageToSerializedUsageCostSessionState(
              getUsageCostSessionMetadata(context),
              provider as "openai" | "anthropic" | "google" | "perplexity",
              model,
              event.result.usage,
            );
            context.metadata.set(USAGE_COST_SESSION_METADATA_KEY, nextUsageCostSession);
          }
          const timelineChanged = applyStreamEventToTimeline(
            event,
            runTimeline,
            toolCallState,
            (delta) => {
              partialAssistantMessage += delta;
            },
          );
          await forwardStreamEvent(event, deps.sendNotification);
          if (timelineChanged || event.type === "response.completed") {
            await deps.persistence.appendRunState(sessionId, {
              runId,
              turnId,
              status: "started",
              startedAt,
              updatedAt: new Date().toISOString(),
              userMessage: userMessagePreview,
              userContent: userInput,
              assistantMessage: partialAssistantMessage || undefined,
              timeline: cloneTimeline(runTimeline),
              metadata: {
                usageCostSession: getUsageCostSessionMetadata(context),
              },
              agentId,
              runtime: resolvedRuntime,
            });
          }
        }
        agentResult = await agentStream.result;
      } catch (streamError) {
        // Suppress unhandled rejection from the paired result promise.
        // agent.stream() resolves/rejects via both iterator and result channels.
        agentStream.result.catch(() => {});
        throw streamError;
      }

      result = {
        sessionId,
        runId,
        turnId,
      status: "success",
      responseId: agentResult.responseId ?? undefined,
        message: agentResult.content ?? "",
        agentId,
        idempotencyKey,
        runtime: resolvedRuntime,
      };

      // Record cost
      if (agentResult.usage.totalCost > 0) {
        await deps.persistence.appendUsage(
          agentResult.usage.totalCost,
          "usd",
          sessionId,
          runId,
        );
        await deps.sendNotification("agent/stream-response", {
          type: "agent.cumulative_cost",
          amount: agentResult.usage.totalCost,
        });
      }

      await deps.sendNotification("agent/stream-response", {
        type: "agent.change_state.finished",
        sessionId,
        runId,
        agentId,
      });
    } else {
      // Non-streaming run
      const agentResult = await agent.invoke(llmInput);

      result = {
        sessionId,
        runId,
        turnId,
      status: "success",
      responseId: agentResult.responseId ?? undefined,
        message: agentResult.content ?? "",
        agentId,
        idempotencyKey,
        runtime: resolvedRuntime,
      };

      if (agentResult.usage.totalCost > 0) {
        await deps.persistence.appendUsage(
          agentResult.usage.totalCost,
          "usd",
          sessionId,
          runId,
        );
      }
    }

    // Persist turn
    const turn: ConversationTurn = {
      turnId,
      runId,
      timestamp: new Date().toISOString(),
      userMessage: userMessagePreview,
      userContent: userInput,
      assistantMessage: result.message,
      responseId: result.responseId,
      status: "success",
      timeline: runTimeline.length > 0 ? finalizeTimeline(runTimeline) : undefined,
      agentId,
      runtime: resolvedRuntime,
    };
    await deps.persistence.appendConversationTurn(sessionId, turn, title);

    await deps.persistence.deleteRunState(sessionId, runId, agentId);
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : String(err);

    result = {
      sessionId,
      runId,
      turnId,
      status: "error",
      message: "",
      agentId,
      idempotencyKey,
      errorMessage,
      runtime: resolvedRuntime,
    };

    // Persist error turn
    const turn: ConversationTurn = {
      turnId,
      runId,
      timestamp: new Date().toISOString(),
      userMessage: userMessagePreview,
      userContent: userInput,
      assistantMessage: "",
      responseId: undefined,
      status: "error",
      errorMessage,
      timeline: runTimeline.length > 0 ? finalizeTimeline(runTimeline) : undefined,
      agentId,
      runtime: resolvedRuntime,
    };
    await deps.persistence.appendConversationTurn(sessionId, turn, title);

    await deps.persistence.deleteRunState(sessionId, runId, agentId);

    if (enableStream && deps.sendNotification) {
      await deps.sendNotification("agent/stream-response", {
        type: "agent.change_state.error",
        sessionId,
        runId,
        agentId,
      });
    }
  }

  const payload = toAgentRunWireResult(result);

  // Write idempotency record
  if (idempotencyKey) {
    await deps.persistence.writeIdempotencyRecord({
      userId: deps.authContext?.userId ?? "anonymous",
      idempotencyKey,
      sessionId,
      runId,
      status: result.status,
      result: payload,
      agentId,
      createdAt: new Date().toISOString(),
    });
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: result.status === "error",
  };
}

async function forwardStreamEvent(
  event: LLMStreamEvent,
  sendNotification: (method: string, params: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  switch (event.type) {
    case "text.delta":
      await sendNotification("agent/stream-response", {
        type: "agent.text_delta",
        delta: event.delta,
      });
      break;
    case "reasoning.delta":
      await sendNotification("agent/stream-response", {
        type: "agent.reasoning_summary_delta",
        delta: event.delta,
      });
      break;
    case "output_item.added":
      await sendNotification("agent/stream-response", {
        type: "agent.output_item.added",
        itemId: event.itemId,
        item: event.item,
        content_type: "artifact",
      });
      break;
    case "artifact.delta":
      await sendNotification("agent/stream-response", {
        type: "agent.artifact_delta",
        itemId: event.itemId,
        delta: event.delta,
      });
      break;
    case "output_item.done":
      await sendNotification("agent/stream-response", {
        type: "agent.output_item.done",
        itemId: event.itemId,
        item: event.item,
        content_type: "artifact",
      });
      break;
    case "tool_call.arguments.done":
      await sendNotification("agent/stream-response", {
        type: "agent.tool_call",
        summary: event.name,
        toolCallId: event.toolCallId,
        arguments: event.arguments,
        description: JSON.stringify(event.arguments, null, 2),
      });
      break;
    case "response.completed":
      if (event.result.content) {
        await sendNotification("agent/stream-response", {
          type: "agent.text_result",
          responseId: event.result.responseId ?? undefined,
        });
      }
      break;
    case "tool_result":
      await sendNotification("agent/stream-response", {
        type: "agent.tool_call_finish",
        summary: event.name,
        toolCallId: event.toolCallId,
        status: event.isError ? "failed" : "completed",
        errorMessage: event.isError ? event.content : undefined,
      });
      break;
  }
}

function applyStreamEventToTimeline(
  event: LLMStreamEvent,
  timeline: TimelineItem[],
  toolCallState: Map<string, { index: number; argumentsText: string }>,
  appendAssistantText: (delta: string) => void,
): boolean {
  const now = Date.now();

  switch (event.type) {
    case "reasoning.delta": {
      const lastItem = timeline[timeline.length - 1];
      if (lastItem?.kind === "reasoning" && lastItem.status === "running") {
        lastItem.text += event.delta;
      } else {
        timeline.push({
          kind: "reasoning",
          id: `reasoning-${timeline.length + 1}`,
          text: event.delta,
          status: "running",
        });
      }
      return true;
    }
    case "reasoning.done": {
      const lastItem = timeline[timeline.length - 1];
      if (lastItem?.kind === "reasoning") {
        lastItem.text = event.text;
        lastItem.status = "completed";
      } else {
        timeline.push({
          kind: "reasoning",
          id: `reasoning-${timeline.length + 1}`,
          text: event.text,
          status: "completed",
        });
      }
      return true;
    }
    case "tool_call.arguments.delta": {
      const existing = toolCallState.get(event.toolCallId);
      if (existing) {
        existing.argumentsText += event.delta;
        const item = timeline[existing.index];
        if (item?.kind === "tool-call") {
          item.argumentLines = toArgumentLines(existing.argumentsText);
        }
      } else {
        timeline.push({
          kind: "tool-call",
          id: event.toolCallId,
          summary: event.name,
          status: "running",
          argumentLines: toArgumentLines(event.delta),
        });
        toolCallState.set(event.toolCallId, {
          index: timeline.length - 1,
          argumentsText: event.delta,
        });
      }
      return true;
    }
    case "tool_call.arguments.done": {
      const argumentText = JSON.stringify(event.arguments, null, 2);
      const existing = toolCallState.get(event.toolCallId);
      if (existing) {
        existing.argumentsText = argumentText;
        const item = timeline[existing.index];
        if (item?.kind === "tool-call") {
          item.summary = event.name;
          item.status = "completed";
          item.argumentLines = toArgumentLines(argumentText);
        }
      } else {
        timeline.push({
          kind: "tool-call",
          id: event.toolCallId,
          summary: event.name,
          status: "completed",
          argumentLines: toArgumentLines(argumentText),
        });
      }
      return true;
    }
    case "tool_result": {
      const existing = toolCallState.get(event.toolCallId);
      if (existing) {
        const item = timeline[existing.index];
        if (item?.kind === "tool-call") {
          item.summary = event.name;
          item.status = event.isError ? "failed" : "completed";
          item.errorMessage = event.isError ? event.content : undefined;
        }
      } else {
        timeline.push({
          kind: "tool-call",
          id: event.toolCallId,
          summary: event.name,
          status: event.isError ? "failed" : "completed",
          errorMessage: event.isError ? event.content : undefined,
        });
      }
      return true;
    }
    case "text.delta": {
      appendAssistantText(event.delta);
      const lastItem = timeline[timeline.length - 1];
      if (lastItem?.kind === "text") {
        lastItem.text += event.delta;
        lastItem.updatedAt = now;
      } else {
        timeline.push({
          kind: "text",
          id: `text-${timeline.length + 1}`,
          text: event.delta,
          startedAt: now,
          updatedAt: now,
        });
      }
      return true;
    }
    case "text.done": {
      const lastItem = timeline[timeline.length - 1];
      if (lastItem?.kind === "text") {
        lastItem.text = event.text;
        lastItem.updatedAt = now;
        lastItem.completedAt = now;
        lastItem.durationSeconds = Math.max(0, (now - lastItem.startedAt) / 1000);
      } else {
        timeline.push({
          kind: "text",
          id: `text-${timeline.length + 1}`,
          text: event.text,
          startedAt: now,
          updatedAt: now,
          completedAt: now,
          durationSeconds: 0,
        });
      }
      return true;
    }
    case "output_item.added": {
      const existing = findArtifactTimelineItem(timeline, event.itemId);
      const path = extractArtifactPath(event.item);
      if (existing) {
        existing.status = "running";
        if (existing.path === undefined && path !== undefined) {
          existing.path = path;
        }
      } else {
        timeline.push({
          kind: "artifact",
          id: event.itemId,
          text: "",
          path,
          contentType: event.contentType,
          status: "running",
        });
      }
      return true;
    }
    case "artifact.delta": {
      for (let index = timeline.length - 1; index >= 0; index -= 1) {
        const item = timeline[index];
        if (item?.kind === "artifact" && item.id === event.itemId) {
          item.text += event.delta;
          return true;
        }
      }
      timeline.push({
        kind: "artifact",
        id: event.itemId,
        text: event.delta,
        contentType: "artifact",
        status: "running",
      });
      return true;
    }
    case "output_item.done": {
      const existing = findArtifactTimelineItem(timeline, event.itemId);
      const path = extractArtifactPath(event.item);
      if (existing) {
        existing.status = "completed";
        if (existing.path === undefined && path !== undefined) {
          existing.path = path;
        }
      } else {
        timeline.push({
          kind: "artifact",
          id: event.itemId,
          text: "",
          path,
          contentType: event.contentType,
          status: "completed",
        });
      }
      return true;
    }
    default:
      return false;
  }
}

function toArgumentLines(argumentText: string): string[] | undefined {
  if (argumentText.length === 0) {
    return undefined;
  }
  return argumentText.split("\n");
}

function findArtifactTimelineItem(
  timeline: TimelineItem[],
  itemId: string,
): Extract<TimelineItem, { kind: "artifact" }> | undefined {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item?.kind === "artifact" && item.id === itemId) {
      return item;
    }
  }
  return undefined;
}

function extractArtifactPath(item: Record<string, unknown>): string | undefined {
  return typeof item.path === "string" && item.path.length > 0
    ? item.path
    : undefined;
}

function cloneTimeline(timeline: TimelineItem[]): TimelineItem[] {
  return timeline.map((item) => ({ ...item }));
}

function finalizeTimeline(timeline: TimelineItem[]): TimelineItem[] {
  const now = Date.now();
  return timeline.map((item) => {
    if (item.kind === "reasoning" || item.kind === "tool-call") {
      if (item.status === "completed" || item.status === "failed") {
        return { ...item };
      }
      return { ...item, status: "completed" };
    }
    if (item.kind === "artifact") {
      if (item.status === "completed") {
        return { ...item };
      }
      return { ...item, status: "completed" };
    }
    if (item.completedAt != null) {
      return { ...item };
    }
    return {
      ...item,
      updatedAt: now,
      completedAt: now,
      durationSeconds: Math.max(0, (now - item.startedAt) / 1000),
    };
  });
}

function toAgentRunWireResult(
  result: Partial<AgentRunResult> | Record<string, unknown>,
): Record<string, unknown> {
  const source = result as Record<string, unknown>;
  const sessionId = stringOrUndefined(source.sessionId ?? source.session_id);
  const runId = stringOrUndefined(source.runId ?? source.run_id);
  const turnId = stringOrUndefined(source.turnId ?? source.turn_id);
  const responseId = stringOrUndefined(source.responseId ?? source.response_id);
  const message = stringOrUndefined(source.message);
  const agentId = stringOrUndefined(source.agentId ?? source.agent_id);
  const idempotencyKey = stringOrUndefined(
    source.idempotencyKey ?? source.idempotency_key,
  );
  const notificationToken = stringOrUndefined(
    source.notificationToken ?? source.notification_token,
  );
  const errorMessage = stringOrUndefined(source.errorMessage ?? source.error_message);
  const status = stringOrUndefined(source.status) ?? "error";
  const runtime = toResolvedRuntimeWireValue(
    source.runtime as ResolvedAgentRuntime | undefined,
  );

  return {
    sessionId: sessionId ?? null,
    runId: runId ?? null,
    turnId: turnId ?? null,
    status,
    responseId: responseId ?? null,
    message: message ?? "",
    agentId: agentId ?? null,
    idempotencyKey: idempotencyKey ?? null,
    notificationToken: notificationToken ?? null,
    errorMessage: errorMessage ?? null,
    runtime,
  };
}

function toRuntimePolicyWireValue(
  runtimePolicy: AgentRuntimePolicy | undefined,
): Record<string, unknown> | null {
  if (!runtimePolicy) {
    return null;
  }
  return {
    provider: runtimePolicy.provider,
    defaults: toResolvedRuntimeWireValue(runtimePolicy.defaults),
    allowedModels: runtimePolicy.allowedModels ?? null,
    allowedReasoningEfforts: runtimePolicy.allowedReasoningEfforts ?? null,
    allowedVerbosity: runtimePolicy.allowedVerbosity ?? null,
  };
}

function toResolvedRuntimeWireValue(
  runtime: ResolvedAgentRuntime | undefined,
): Record<string, unknown> | null {
  if (!runtime) {
    return null;
  }
  return {
    model: runtime.model,
    reasoningEffort: runtime.reasoningEffort ?? null,
    verbosity: runtime.verbosity ?? null,
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function resolveUserInput(
  input: AgentRunParams["input"],
  message: AgentRunParams["message"],
): string | ContentPart[] | undefined {
  return input ?? message;
}

function resolveAgentProvider(agent: unknown): string | null {
  const provider = (agent as { options?: { client?: { provider?: string } } })?.options?.client?.provider;
  return typeof provider === "string" ? provider : null;
}

function resolveAgentModel(agent: unknown): string | null {
  const model = (agent as { options?: { client?: { model?: string } } })?.options?.client?.model;
  return typeof model === "string" ? model : null;
}

function findLatestResponseId(turns: ConversationTurn[]): string | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const responseId = turns[index]?.responseId;
    if (typeof responseId === "string" && responseId.length > 0) {
      return responseId;
    }
  }
  return undefined;
}

async function hydrateHistoryFromPersistence(
  persistence: McpPersistence,
  history: InMemoryHistory,
  sessionId: string,
  agentId?: string,
): Promise<void> {
  const conversation = await persistence.readConversation(sessionId, agentId);
  if (!conversation) {
    return;
  }

  for (const turn of conversation.turns) {
    await history.addMessage({
      role: "user",
      content: turn.userContent ?? turn.userMessage,
    });

    const assistantContent = buildAssistantHistoryContent(turn);
    if (!assistantContent) {
      continue;
    }

    await history.addMessage({
      role: "assistant",
      content: assistantContent,
    });
  }
}

function buildAssistantHistoryContent(turn: ConversationTurn): string {
  const parts: string[] = [];
  const assistantMessage = turn.assistantMessage.trim();
  if (assistantMessage.length > 0) {
    parts.push(assistantMessage);
  }

  const artifactTexts = (turn.timeline ?? [])
    .filter((item): item is Extract<TimelineItem, { kind: "artifact" }> => item.kind === "artifact")
    .map((item) => item.text.trim())
    .filter((text) => text.length > 0);

  if (artifactTexts.length > 0) {
    parts.push(artifactTexts.join("\n\n"));
  }

  return parts.join("\n\n").trim();
}

function getUsageCostSessionMetadata(
  context: AgentContextImpl,
): SerializedUsageCostSessionState | undefined {
  const value = context.metadata.get(USAGE_COST_SESSION_METADATA_KEY);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as SerializedUsageCostSessionState;
}

function toUserMessagePreview(input: string | ContentPart[]): string {
  if (typeof input === "string") {
    return input;
  }
  const preview = input
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "image":
          if (part.source.type === "url") {
            return `[image:url:${part.source.url}]`;
          }
          return `[image:base64:${part.source.mediaType}]`;
        case "file":
          if (part.file.source.type === "asset-ref") {
            return `[file:${part.file.name}:${part.file.mimeType}:${part.file.source.assetRef}]`;
          }
          if (part.file.source.type === "url") {
            return `[file:${part.file.name}:${part.file.mimeType}:${part.file.source.url}]`;
          }
          return `[file:${part.file.name}:${part.file.mimeType}:base64]`;
        case "audio":
          return `[audio:${part.format}]`;
      }
    })
    .join(" ");
  return preview.trim();
}

interface NormalizeUserInputOptions {
  appName?: string;
  agentId?: string;
  sessionId: string;
  publicAssetStorage?: PublicAssetStorage;
  publicAssetsDir?: string;
}

interface NormalizeUserInputForLlmOptions {
  appName?: string;
  publicAssetStorage?: PublicAssetStorage;
  publicAssetsDir?: string;
  publicAssetsBasePath: string;
}

async function normalizeUserInputForPersistence(
  input: string | ContentPart[],
  options: NormalizeUserInputOptions,
): Promise<{ input: string | ContentPart[] }> {
  if (typeof input === "string") {
    return { input };
  }

  const publicAssetStorage = resolvePublicAssetStorage(options);
  let totalImageBytes = 0;
  let totalFileBytes = 0;
  const normalized: ContentPart[] = [];
  for (const part of input) {
    if (part.type === "file") {
      const normalizedFile = await normalizeFilePartForPersistence(part, options);
      totalFileBytes += normalizedFile.bytesAdded;
      if (totalFileBytes > MAX_BASE64_FILE_BYTES_PER_TURN) {
        throw new Error(
          `base64 file payload exceeds ${MAX_BASE64_FILE_BYTES_PER_TURN} bytes per turn`,
        );
      }
      normalized.push(normalizedFile.part);
      continue;
    }

    if (part.type !== "image") {
      normalized.push(part);
      continue;
    }

    let resolvedMediaType: string | null = null;
    let resolvedBase64Data: string | null = null;

    if (part.source.type === "base64") {
      resolvedMediaType = normalizeMediaType(part.source.mediaType);
      resolvedBase64Data = part.source.data;
    } else if (part.source.type === "url") {
      const parsedDataUrl = parseImageBase64DataUrl(part.source.url);
      if (!parsedDataUrl) {
        normalized.push(part);
        continue;
      }
      resolvedMediaType = parsedDataUrl.mediaType;
      resolvedBase64Data = parsedDataUrl.data;
    }

    if (!publicAssetStorage) {
      throw new Error("base64 image input is not supported without a configured public asset storage");
    }
    if (!resolvedMediaType || resolvedBase64Data === null) {
      normalized.push(part);
      continue;
    }
    const mediaType = resolvedMediaType;
    const extension = IMAGE_MEDIA_TYPE_TO_EXTENSION[mediaType];
    if (!extension) {
      throw new Error(`unsupported image mediaType: ${mediaType}`);
    }

    const imageBytes = decodeBase64Data(resolvedBase64Data);
    totalImageBytes += imageBytes.length;
    if (totalImageBytes > MAX_BASE64_IMAGE_BYTES_PER_TURN) {
      throw new Error(
        `base64 image payload exceeds ${MAX_BASE64_IMAGE_BYTES_PER_TURN} bytes per turn`,
      );
    }
    if (!matchesImageMediaType(imageBytes, mediaType)) {
      throw new Error(`image mediaType does not match binary content: ${mediaType}`);
    }

    const saved = await publicAssetStorage.saveImage({
      agentId: options.agentId,
      sessionId: options.sessionId,
      mediaType,
      bytes: imageBytes,
    });
    normalized.push({
      type: "image",
      source: { type: "url", url: saved.assetRef },
    });
  }

  return { input: normalized };
}

async function normalizeFilePartForPersistence(
  part: Extract<ContentPart, { type: "file" }>,
  options: NormalizeUserInputOptions,
): Promise<{ part: Extract<ContentPart, { type: "file" }>; bytesAdded: number }> {
  const publicAssetStorage = resolvePublicAssetStorage(options);
  if (part.file.source.type === "asset-ref") {
    return { part, bytesAdded: 0 };
  }
  if (part.file.source.type === "url" && !part.file.source.url.startsWith("data:")) {
    return { part, bytesAdded: 0 };
  }
  if (!publicAssetStorage) {
    throw new Error("base64 file input is not supported without a configured public asset storage");
  }

  const base64Source =
    part.file.source.type === "base64"
      ? part.file.source
      : parseBase64DataUrl(part.file.source.url);
  if (!base64Source) {
    return { part, bytesAdded: 0 };
  }

  const mimeType = normalizeMediaType(base64Source.mediaType || part.file.mimeType);
  const bytes = decodeBase64Data(base64Source.data);
  const saved = await publicAssetStorage.saveFile({
    agentId: options.agentId,
    sessionId: options.sessionId,
    mimeType,
    fileName: part.file.name,
    bytes,
  });
  return {
    part: {
      type: "file",
      file: {
        ...part.file,
        mimeType,
        sizeBytes: bytes.length,
        source: {
          type: "asset-ref",
          assetRef: saved.assetRef,
        },
      },
    },
    bytesAdded: bytes.length,
  };
}

function parseImageBase64DataUrl(url: string): { mediaType: string; data: string } | null {
  const parsed = parseBase64DataUrl(url);
  if (!parsed) {
    return null;
  }
  return { mediaType: parsed.mediaType, data: parsed.data };
}

async function normalizeUserInputForLlm(
  input: string | ContentPart[],
  options: NormalizeUserInputForLlmOptions,
): Promise<string | ContentPart[]> {
  if (typeof input === "string") {
    return input;
  }

  const publicAssetStorage = resolvePublicAssetStorage(options);
  const normalized: ContentPart[] = [];
  for (const part of input) {
    if (part.type === "file") {
      normalized.push(...await normalizeFilePartForLlm(part, options, publicAssetStorage));
      continue;
    }
    if (part.type !== "image" || part.source.type !== "url") {
      normalized.push(part);
      continue;
    }
    if (part.source.url.startsWith("data:")) {
      normalized.push(part);
      continue;
    }

    const assetRef = resolveStoredImageAssetRef(
      part.source.url,
      {
        appName: options.appName,
        publicAssetsBasePath: options.publicAssetsBasePath,
      },
    );
    if (!assetRef) {
      normalized.push(part);
      continue;
    }
    if (!publicAssetStorage) {
      throw new Error("local public image URL input is not supported without a configured public asset storage");
    }

    const resolved = await publicAssetStorage.resolveForLlm({ assetRef });
    normalized.push({
      type: "image",
      source: {
        type: "url",
        url: resolved.mode === "data-url" ? resolved.dataUrl : resolved.url,
      },
    });
  }

  return normalized;
}

async function normalizeFilePartForLlm(
  part: Extract<ContentPart, { type: "file" }>,
  options: NormalizeUserInputForLlmOptions,
  publicAssetStorage: PublicAssetStorage | null,
): Promise<ContentPart[]> {
  const assetRef =
    part.file.source.type === "asset-ref"
      ? part.file.source.assetRef
      : part.file.source.type === "url"
        ? resolveStoredImageAssetRef(part.file.source.url, {
            appName: options.appName,
            publicAssetsBasePath: options.publicAssetsBasePath,
          })
        : null;
  const referenceText = describeFileReference(part);
  if (!assetRef || !publicAssetStorage?.readPublicAsset) {
    return [{ type: "text", text: referenceText }];
  }

  const asset = await publicAssetStorage.readPublicAsset(assetRef);
  if (!asset) {
    return [{ type: "text", text: referenceText }];
  }

  if (
    (part.file.mimeType === "text/plain" || part.file.mimeType === "text/markdown") &&
    asset.bytes.length <= MAX_TEXT_FILE_BYTES_FOR_INLINE_LLM
  ) {
    return [{
      type: "text",
      text: `${referenceText}\n\n--- BEGIN ATTACHMENT ---\n${Buffer.from(asset.bytes).toString("utf-8")}\n--- END ATTACHMENT ---`,
    }];
  }

  return [{ type: "text", text: referenceText }];
}

function resolveStoredImageAssetRef(
  url: string,
  options: {
    appName?: string;
    publicAssetsBasePath: string;
  },
): string | null {
  if (isAssetRef(url)) {
    return url;
  }
  if (isStoredAssetPath(url)) {
    return options.appName ? toFileSystemAssetRef(options.appName, url) : null;
  }

  const relativePath = resolvePublicAssetRelativePath(url, options.publicAssetsBasePath);
  if (!relativePath) {
    return null;
  }
  if (relativePath.startsWith("ref/")) {
    return decodePublicAssetRef(relativePath.slice(4));
  }
  return options.appName ? toFileSystemAssetRef(options.appName, relativePath) : null;
}

function isStoredAssetPath(value: string): boolean {
  // Stored JSONL values use a path-like representation under the public root.
  return /^uploads\/[^?#]+$/.test(value);
}

function isAssetRef(value: string): boolean {
  return /^storage\+[A-Za-z0-9+.-]+:/.test(value);
}

function resolvePublicAssetRelativePath(url: string, publicAssetsBasePath: string): string | null {
  const normalizedBasePath = publicAssetsBasePath.replace(/\/+$/, "");
  if (url.startsWith(`${normalizedBasePath}/`)) {
    return url.slice(normalizedBasePath.length + 1);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isLocalAddress(parsed.hostname)) {
    return null;
  }
  if (!parsed.pathname.startsWith(`${normalizedBasePath}/`)) {
    return null;
  }
  return parsed.pathname.slice(normalizedBasePath.length + 1);
}

function resolvePublicAssetStorage(options: {
  appName?: string;
  publicAssetStorage?: PublicAssetStorage;
  publicAssetsDir?: string;
}): PublicAssetStorage | null {
  if (options.publicAssetStorage) {
    return options.publicAssetStorage;
  }
  if (options.appName && options.publicAssetsDir) {
    return new FileSystemPublicAssetStorage({
      appName: options.appName,
      publicDir: options.publicAssetsDir,
    });
  }
  return null;
}

function decodePublicAssetRef(encodedAssetRef: string): string | null {
  try {
    const decoded = decodeURIComponent(encodedAssetRef);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function describeFileReference(part: Extract<ContentPart, { type: "file" }>): string {
  const location =
    part.file.source.type === "asset-ref"
      ? part.file.source.assetRef
      : part.file.source.type === "url"
        ? part.file.source.url
        : "inline-base64";
  return `[Attached file] name=${part.file.name} mimeType=${part.file.mimeType} sizeBytes=${part.file.sizeBytes} source=${location}`;
}

function parseBase64DataUrl(url: string): { mediaType: string; data: string } | null {
  if (!url.startsWith("data:")) {
    return null;
  }
  const commaIndex = url.indexOf(",");
  if (commaIndex <= 5) {
    throw new Error("invalid data URL payload");
  }
  const header = url.slice(5, commaIndex);
  if (!/;base64(?:;|$)/i.test(header)) {
    return null;
  }
  const mediaType = normalizeMediaType(header.split(";")[0] ?? "");
  return { mediaType, data: url.slice(commaIndex + 1) };
}

function isLocalAddress(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1";
}

function normalizeMediaType(mediaType: string): string {
  return mediaType.trim().toLowerCase().split(";")[0] ?? "";
}

function decodeBase64Data(data: string): Buffer {
  const normalized = data.replace(/\s+/g, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new Error("invalid base64 image payload");
  }
  return Buffer.from(normalized, "base64");
}

function matchesImageMediaType(bytes: Buffer, mediaType: string): boolean {
  switch (mediaType) {
    case "image/png":
      return bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a;
    case "image/jpeg":
      return bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff;
    case "image/gif":
      return bytes.length >= 6 &&
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61;
    case "image/webp":
      return bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50;
    default:
      return false;
  }
}
