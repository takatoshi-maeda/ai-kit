import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentRegistry } from "../agent-registry.js";
import type { McpPersistence, ConversationTurn, TimelineItem } from "../persistence.js";
import { AgentContextImpl } from "../../context.js";
import { InMemoryHistory } from "../../conversation/memory-history.js";
import type { LLMStreamEvent } from "../../../types/stream-events.js";
import type { ContentPart } from "../../../types/llm.js";

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
    type: z.literal("audio"),
    data: z.string(),
    format: z.string(),
  }),
]);

const ContentPartArraySchema = z.array(ContentPartSchema);

const UserInputSchema = z.union([z.string(), ContentPartArraySchema]);

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
}

/** MCP ストリーム通知イベント */
export type McpStreamNotification =
  | { type: "agent.change_state.started"; sessionId: string; runId: string; agentId?: string; agentName?: string }
  | { type: "agent.reasoning_summary_delta"; delta: string }
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
  sendNotification?: (method: string, params: Record<string, unknown>) => Promise<void>;
  publicAssetsDir?: string;
  publicAssetsBasePath?: string;
}

const MAX_BASE64_IMAGE_BYTES_PER_TURN = 2 * 1024 * 1024;

const IMAGE_MEDIA_TYPE_TO_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const IMAGE_EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
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
    params: agentParams,
    agentId: requestedAgentId,
    stream: enableStream,
  } = params;

  const agentId = deps.registry.resolveAgentId(requestedAgentId);
  const sessionId = requestedSessionId ?? crypto.randomUUID();
  const runId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const resolvedUserInput = resolveUserInput(input, message);

  if (resolvedUserInput === undefined) {
    throw new Error("Either message or input must be provided");
  }

  const normalized = await normalizeUserInputForPersistence(
    resolvedUserInput,
    {
      sessionId,
      publicAssetsDir: deps.publicAssetsDir,
      publicAssetsBasePath:
        deps.publicAssetsBasePath ?? `/api/mcp/${encodeURIComponent(agentId)}/public`,
    },
  );
  const publicAssetsBasePath =
    deps.publicAssetsBasePath ?? `/api/mcp/${encodeURIComponent(agentId)}/public`;
  const userInput = normalized.input;
  const userMessagePreview = toUserMessagePreview(normalized.input);
  // We persist userContent as public URLs, while converting local public asset URLs
  // to data URLs only for upstream LLM APIs that reject localhost/relative URLs.
  const llmInput = await normalizeUserInputForLlm(userInput, {
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
  const entry = deps.registry.get(agentId);
  const context = new AgentContextImpl({
    history: new InMemoryHistory(),
    sessionId,
    selectedAgentName: agentId,
  });

  const agent = entry.create(context, agentParams);

  let result: AgentRunResult;

  try {
    if (enableStream && deps.sendNotification) {
      // Run with streaming notifications
      const agentStream = agent.stream(llmInput);
      let agentResult: Awaited<typeof agentStream.result>;
      try {
        for await (const event of agentStream) {
          const timelineChanged = applyStreamEventToTimeline(
            event,
            runTimeline,
            toolCallState,
            (delta) => {
              partialAssistantMessage += delta;
            },
          );
          await forwardStreamEvent(event, deps.sendNotification);
          if (timelineChanged) {
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
              agentId,
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
      status: "success",
      timeline: runTimeline.length > 0 ? finalizeTimeline(runTimeline) : undefined,
      agentId,
    };
    await deps.persistence.appendConversationTurn(sessionId, turn, title);

    // Update run state
    await deps.persistence.appendRunState(sessionId, {
      runId,
      turnId,
      status: "success",
      startedAt,
      updatedAt: new Date().toISOString(),
      userMessage: userMessagePreview,
      userContent: userInput,
      assistantMessage: result.message,
      timeline: runTimeline.length > 0 ? finalizeTimeline(runTimeline) : undefined,
      agentId,
    });
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
    };

    // Persist error turn
    const turn: ConversationTurn = {
      turnId,
      runId,
      timestamp: new Date().toISOString(),
      userMessage: userMessagePreview,
      userContent: userInput,
      assistantMessage: "",
      status: "error",
      errorMessage,
      timeline: runTimeline.length > 0 ? finalizeTimeline(runTimeline) : undefined,
      agentId,
    };
    await deps.persistence.appendConversationTurn(sessionId, turn, title);

    // Update run state
    await deps.persistence.appendRunState(sessionId, {
      runId,
      turnId,
      status: "error",
      startedAt,
      updatedAt: new Date().toISOString(),
      userMessage: userMessagePreview,
      userContent: userInput,
      timeline: runTimeline.length > 0 ? finalizeTimeline(runTimeline) : undefined,
      agentId,
    });

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
        case "audio":
          return `[audio:${part.format}]`;
      }
    })
    .join(" ");
  return preview.trim();
}

interface NormalizeUserInputOptions {
  sessionId: string;
  publicAssetsDir?: string;
  publicAssetsBasePath: string;
}

interface NormalizeUserInputForLlmOptions {
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

  let totalImageBytes = 0;
  const normalized: ContentPart[] = [];
  for (const part of input) {
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

    if (!options.publicAssetsDir) {
      throw new Error("base64 image input is not supported without a configured public assets directory");
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

    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const day = String(now.getUTCDate()).padStart(2, "0");
    const sessionSegment = toSafePathSegment(options.sessionId);
    const fileName = `${crypto.randomUUID()}.${extension}`;

    const fsPath = path.join(
      options.publicAssetsDir,
      "uploads",
      year,
      month,
      day,
      sessionSegment,
      fileName,
    );
    await fs.mkdir(path.dirname(fsPath), { recursive: true });
    await fs.writeFile(fsPath, imageBytes);

    const storedFilePath = `uploads/${year}/${month}/${day}/${sessionSegment}/${fileName}`;
    normalized.push({
      type: "image",
      source: { type: "url", url: storedFilePath },
    });
  }

  return { input: normalized };
}

function parseImageBase64DataUrl(url: string): { mediaType: string; data: string } | null {
  if (!url.startsWith("data:")) {
    return null;
  }
  const commaIndex = url.indexOf(",");
  if (commaIndex <= 5) {
    throw new Error("invalid data URL image payload");
  }
  const header = url.slice(5, commaIndex);
  if (!/;base64(?:;|$)/i.test(header)) {
    return null;
  }
  const mediaType = normalizeMediaType(header.split(";")[0] ?? "");
  return { mediaType, data: url.slice(commaIndex + 1) };
}

async function normalizeUserInputForLlm(
  input: string | ContentPart[],
  options: NormalizeUserInputForLlmOptions,
): Promise<string | ContentPart[]> {
  if (typeof input === "string") {
    return input;
  }

  const normalized: ContentPart[] = [];
  for (const part of input) {
    if (part.type !== "image" || part.source.type !== "url") {
      normalized.push(part);
      continue;
    }
    if (part.source.url.startsWith("data:")) {
      normalized.push(part);
      continue;
    }

    const relativePath = resolveStoredImageRelativePath(
      part.source.url,
      options.publicAssetsBasePath,
    );
    if (!relativePath) {
      normalized.push(part);
      continue;
    }
    if (!options.publicAssetsDir) {
      throw new Error("local public image URL input is not supported without a configured public assets directory");
    }

    const fullPath = resolveSafePublicAssetFilePath(options.publicAssetsDir, relativePath);
    const extension = path.extname(fullPath).slice(1).toLowerCase();
    const mediaType = IMAGE_EXTENSION_TO_MEDIA_TYPE[extension];
    if (!mediaType) {
      throw new Error(`unsupported image extension for local asset URL: .${extension}`);
    }

    const bytes = await fs.readFile(fullPath);
    const dataUrl = `data:${mediaType};base64,${bytes.toString("base64")}`;
    normalized.push({
      type: "image",
      source: {
        type: "url",
        url: dataUrl,
      },
    });
  }

  return normalized;
}

function resolveStoredImageRelativePath(url: string, publicAssetsBasePath: string): string | null {
  if (isStoredAssetPath(url)) {
    return url;
  }
  return resolvePublicAssetRelativePath(url, publicAssetsBasePath);
}

function isStoredAssetPath(value: string): boolean {
  // Stored JSONL values use a path-like representation under the public root.
  return /^uploads\/[^?#]+$/.test(value);
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

function resolveSafePublicAssetFilePath(publicAssetsDir: string, relativePath: string): string {
  const normalized = path.posix.normalize(`/${relativePath}`);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("invalid local public image URL path");
  }

  const root = path.resolve(publicAssetsDir);
  const fullPath = path.resolve(root, ...segments);
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
    throw new Error("local public image URL path escapes public directory");
  }
  return fullPath;
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

function toSafePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "session";
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
